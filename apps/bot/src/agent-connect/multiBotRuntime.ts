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
import { logger } from "./logger.js";
import { MessageQueueManager } from "./messageQueue.js";
import { telegramApiFromGrammy } from "./messageSender.js";
import { migrateJsonToSqliteIfNeeded } from "./migration.js";
import { OutboundDispatcher, outboundRegistry } from "./outboundDispatcher.js";
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
  /**
   * Bot ids whose grammy runtime crashed since their last successful start
   * (i.e. `bot.start(...)` rejected after we had already considered the
   * instance up). Cleared on the next successful `startBot`. Surfaced to
   * `/healthz` via {@link hasCrashedBot} so the supervisor can detect a
   * dead TG polling loop even when the HTTP/Fastify server is still up.
   *
   * The on-disk Telegram bug we're guarding against:
   *   - Resume Session callback → createAndBindWindow runs slow tmux work
   *   - Late `answerCallbackQuery` throws 400 ("query is too old")
   *   - Unhandled error in grammy → `bot.start` promise rejects
   *   - HTTP server keeps serving healthz=200, but TG polling is dead
   *   - Pre-fix: ~12h of silence before anyone noticed.
   * Now: crash → `hasCrashedBot()` = true → healthz 503 →
   *      supervisor's `defaultProbeHealth` sees non-2xx → restart.
   */
  private readonly crashedBots = new Set<string>();

  constructor(
    private readonly baseConfig: Config,
    private readonly store: SqliteConfigStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  activeCount(): number {
    return this.instances.size;
  }

  hasCrashedBot(): boolean {
    return this.crashedBots.size > 0;
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
        logger().error({ botId: record.id, name: record.name, err: error }, "failed to start bot runtime");
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

      const sessionManager = new SessionManager({ config, tmuxManager, registry });
      sessionManager.hydrateFromRegistry(registry);
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
      const onTurnEnd = async (windowId: string, outcome: "success" | "failure") => {
        const emoji = outcome === "success" ? "👌" : "🤔";
        for (const [userId, _w, threadId] of sessionManager.findUsersForWindow(windowId)) {
          const messageId = messageQueue.getLastAssistantMessageId(userId, threadId);
          if (!messageId) continue;
          const chatId = sessionManager.resolveChatId(userId, threadId);
          try {
            await api.setMessageReaction?.(chatId, messageId, [{ type: "emoji", emoji }]);
          } catch {
            // Best-effort. Reactions may be disabled in the group, the bot may
            // lack permission, or the message may have been deleted — none of
            // those are fatal for delivery.
          }
        }
      };
      const onStatusEvent = async (windowId: string, statusText: string) => {
        for (const [userId, _w, threadId] of sessionManager.findUsersForWindow(windowId)) {
          messageQueue.enqueueStatusUpdate(userId, windowId, statusText, threadId);
          await messageQueue.drain(userId);
        }
      };
      const hookRouter = new HookRouter({
        registry,
        dispatcher,
        onTurnEnd,
        onStatusEvent,
        agentType: config.agentType
      });
      hookRouterRegistry.set(config.tmuxSessionName, hookRouter);
      const outboundDispatcher = new OutboundDispatcher({ sessionManager, messageQueue });
      outboundRegistry.set(config.tmuxSessionName, outboundDispatcher);

      // Startup catch-up: deliver any assistant text written while the bot was offline.
      for (const session of registry.allLiveSessions()) {
        try {
          await drainTranscript(registry, dispatcher, session.session_id);
        } catch (error) {
          logger().warn(
            {
              botId: record.id,
              sessionId: session.session_id,
              windowId: session.window_id,
              transcriptPath: session.transcript_path,
              lastByteOffset: session.last_byte_offset,
              err: error
            },
            "startup catch-up drainTranscript failed"
          );
        }
      }

      const statusPoller = new StatusPoller(
        {
          api,
          routing: sessionManager,
          sessionManager,
          registry,
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
      // Successful start clears any previous crash flag — supervisor should
      // see the bot as healthy again once we're polling.
      this.crashedBots.delete(record.id);
      this.setStatus(record.id, {
        running: true,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        lastError: null
      });

      void bot.start({ allowed_updates: ["message", "callback_query"] }).catch((error: unknown) => {
        logger().error({ botId: record.id, err: error }, "bot runtime stopped with error");
        // Mark crashed BEFORE the cleanup so /healthz returns 503 and the
        // supervisor's healthz probe trips a restart instead of staying
        // green forever while TG polling is silently dead. We can't
        // delegate cleanup to `stopBot` here because stopBot intentionally
        // clears the crash flag (so user-initiated stops don't keep the
        // service unhealthy). Inline the teardown so the flag persists.
        this.crashedBots.add(record.id);
        this.setStatus(record.id, {
          running: false,
          stoppedAt: new Date().toISOString(),
          lastError: errorMessage(error)
        });
        const dead = this.instances.get(record.id);
        if (dead) {
          this.instances.delete(record.id);
          void this.stopInstance(dead);
        }
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
    // Stopping (whether triggered by a user or as cleanup from a crash
    // handler) ends the crashed state — supervisor's next healthz probe
    // shouldn't continue tripping a restart for a bot that's already gone.
    this.crashedBots.delete(id);
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
    outboundRegistry.delete(instance.config.tmuxSessionName);
    try {
      await instance.bot.stop();
    } catch (error) {
      logger().error({ botId: instance.id, err: error }, "failed to stop bot runtime");
    }
    try {
      instance.db.close();
    } catch (error) {
      logger().error({ botId: instance.id, err: error }, "failed to close bot.sqlite");
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
