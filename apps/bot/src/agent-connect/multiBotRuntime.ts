import { join } from "node:path";
import Database from "better-sqlite3";
import type { Bot } from "grammy";
import { BashCaptureManager } from "./bashCapture.js";
import { registerBotHandlers, setupBotCommandsIfPossible } from "./bot.js";
import { Config } from "./config.js";
import type { BotConfigRecord } from "./botConfig.js";
import type { SqliteConfigStore } from "./configStore.js";
import { drainTranscript, type Dispatcher, type NewMessageLike } from "./drainTranscript.js";
import { HookRouter } from "./hookRouter.js";
import { MessageQueueManager } from "./messageQueue.js";
import { telegramApiFromGrammy } from "./messageSender.js";
import { migrateJsonToSqliteIfNeeded } from "./migration.js";
import { handleNewMessage } from "./runtime.js";
import { SessionManager } from "./session.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { StatusPoller } from "./statusPolling.js";
import { createGrammyBot } from "./telegramClient.js";
import { TmuxManager } from "./tmuxManager.js";

export interface BotRuntimeInstance {
  id: string;
  name: string;
  config: Config;
  bot: Bot;
  hookRouter: HookRouter;
  registry: SessionRegistry;
  db: Database.Database;
  statusPoller: StatusPoller;
  bashCapture: BashCaptureManager;
}

export interface BotRuntimeStatus {
  id: string;
  running: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
}

// Global registry of per-bot HookRouters, keyed by tmux session name.
// Fastify /hook/events endpoint uses this to route incoming events.
export const hookRouterRegistry = new Map<string, HookRouter>();

export class MultiBotRuntimeManager {
  private readonly instances = new Map<string, BotRuntimeInstance>();
  private readonly statuses = new Map<string, BotRuntimeStatus>();

  constructor(
    private readonly baseConfig: Config,
    private readonly store: SqliteConfigStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  activeCount(): number {
    return this.instances.size;
  }

  activeBots(): Array<{ id: string; name: string; tmuxSessionName: string }> {
    return [...this.instances.values()].map((instance) => ({
      id: instance.id,
      name: instance.name,
      tmuxSessionName: instance.config.tmuxSessionName
    }));
  }

  getBotStatus(id: string): BotRuntimeStatus {
    return (
      this.statuses.get(id) ?? {
        id,
        running: false,
        startedAt: null,
        stoppedAt: null,
        lastError: null
      }
    );
  }

  async startEnabled(): Promise<void> {
    for (const record of this.store.listEnabledBots()) {
      try {
        await this.startBot(record);
      } catch (error) {
        console.error(`Failed to start bot runtime ${record.id}:`, error);
      }
    }
  }

  async startBot(record: BotConfigRecord): Promise<void> {
    if (this.instances.has(record.id)) return;

    this.setStatus(record.id, { running: false, lastError: null });
    try {
      const config = new Config(this.env, { bot: record });
      const tmuxManager = new TmuxManager(config);
      await tmuxManager.getOrCreateSession();

      const botDir = config.configDir;
      await migrateJsonToSqliteIfNeeded(botDir, config.tmuxSessionName, config.agentType);
      const db = new Database(join(botDir, "bot.sqlite"));
      const registry = new SessionRegistry(db);

      const sessionManager = new SessionManager({ config, tmuxManager });
      await sessionManager.resolveStaleIds();

      const bot = createGrammyBot(config.telegramBotToken);
      const api = telegramApiFromGrammy(bot);
      const messageQueue = new MessageQueueManager(api, sessionManager);
      const bashCapture = new BashCaptureManager({
        api,
        routing: sessionManager,
        tmuxManager
      });

      registerBotHandlers(bot, config, sessionManager, tmuxManager, {
        api,
        messageQueue,
        bashCapture
      });
      await bot.init();
      await setupBotCommandsIfPossible(bot.api);

      const dispatcher: Dispatcher = async (_windowId, entries: NewMessageLike[]) => {
        for (const msg of entries) {
          await handleNewMessage(msg, { config, sessionManager, messageQueue });
        }
      };
      const hookRouter = new HookRouter({ registry, dispatcher, agentType: config.agentType });
      hookRouterRegistry.set(config.tmuxSessionName, hookRouter);

      // Startup catch-up: deliver any assistant text written while the bot was offline.
      for (const session of registry.allLiveSessions()) {
        try {
          await drainTranscript(registry, dispatcher, session.session_id);
        } catch (error) {
          console.warn(`startup drainTranscript ${session.session_id} failed:`, error);
        }
      }

      const statusPoller = new StatusPoller(
        {
          api,
          routing: sessionManager,
          sessionManager,
          tmuxManager,
          messageQueue
        },
        undefined,
        config.topicProbeInterval
      );
      statusPoller.start();

      const instance: BotRuntimeInstance = {
        id: record.id,
        name: record.name,
        config,
        bot,
        hookRouter,
        registry,
        db,
        statusPoller,
        bashCapture
      };
      this.instances.set(record.id, instance);
      this.setStatus(record.id, {
        running: true,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        lastError: null
      });

      void bot.start({ allowed_updates: ["message", "callback_query"] }).catch((error: unknown) => {
        console.error(`Bot runtime ${record.id} stopped with error:`, error);
        this.setStatus(record.id, {
          running: false,
          stoppedAt: new Date().toISOString(),
          lastError: errorMessage(error)
        });
        void this.stopBot(record.id);
      });
    } catch (error) {
      this.setStatus(record.id, {
        running: false,
        stoppedAt: new Date().toISOString(),
        lastError: errorMessage(error)
      });
      throw error;
    }
  }

  async restartBot(record: BotConfigRecord): Promise<void> {
    await this.stopBot(record.id);
    if (record.enabled) {
      await this.startBot(record);
    }
  }

  async stopBot(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.instances.delete(id);
    await this.stopInstance(instance);
    this.setStatus(id, {
      running: false,
      stoppedAt: new Date().toISOString()
    });
  }

  async stopAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      await this.stopInstance(instance);
      this.setStatus(instance.id, {
        running: false,
        stoppedAt: new Date().toISOString()
      });
    }
    this.instances.clear();
  }

  private async stopInstance(instance: BotRuntimeInstance): Promise<void> {
    instance.bashCapture.cancelAll();
    await instance.statusPoller.stop();
    hookRouterRegistry.delete(instance.config.tmuxSessionName);
    try {
      await instance.bot.stop();
    } catch (error) {
      console.error(`Failed to stop bot runtime ${instance.id}:`, error);
    }
    try {
      instance.db.close();
    } catch (error) {
      console.error(`Failed to close bot.sqlite for ${instance.id}:`, error);
    }
  }

  private setStatus(id: string, patch: Partial<Omit<BotRuntimeStatus, "id">>): void {
    const current = this.getBotStatus(id);
    this.statuses.set(id, {
      ...current,
      ...patch
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
