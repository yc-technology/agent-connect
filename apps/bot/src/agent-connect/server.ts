import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import {
  type BotConfigRecord,
  type BotConfigInput,
  type BotConfigPatch,
  type PublicBotConfig,
  toPublicBotConfig
} from "./botConfig.js";
import type { SqliteConfigStore } from "./configStore.js";
import type { BotRuntimeStatus } from "./multiBotRuntime.js";
import { proxyConfigLabel, readHttpProxyConfig } from "./proxy.js";

export interface RuntimeState {
  startedAt: string;
  botReady: boolean;
  activeBots?: number;
}

export interface ServerDeps {
  configStore?: SqliteConfigStore;
  runtimeManager?: BotRuntimeControl;
}

export interface BotRuntimeControl {
  activeCount(): number;
  getBotStatus(id: string): BotRuntimeStatus;
  startBot(record: BotConfigRecord): Promise<void>;
  restartBot(record: BotConfigRecord): Promise<void>;
  stopBot(id: string): Promise<void>;
}

type RuntimeAction = "none" | "started" | "restarted" | "stopped";

interface BotMutationResponse extends PublicBotConfig {
  runtimeApplied: boolean;
  runtimeAction: RuntimeAction;
  activeBots: number;
}

interface BotStatusResponse {
  id: string;
  enabled: boolean;
  agentType: string;
  telegramBotTokenSet: boolean;
  openaiApiKeySet: boolean;
  allowedUsers: number[];
  tmuxSessionName: string;
  runtime: BotRuntimeStatus;
  activeBots: number;
}

interface BotConnectivityResponse {
  ok: boolean;
  latencyMs: number;
  runtimeRunning: boolean;
  proxy: string;
  botId: number | null;
  username: string | null;
  firstName: string | null;
  error: string | null;
}

export function createServer(config: Config, state: RuntimeState, deps: ServerDeps = {}): FastifyInstance {
  const server = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            level: process.env.AGENT_CONNECT_LOG_LEVEL ?? "info"
          }
  });

  server.get("/healthz", async () => ({
    ok: true,
    service: "agent-connect",
    startedAt: state.startedAt,
    activeBots: activeBotCount(state, deps.runtimeManager)
  }));

  server.get("/readyz", async (_request, reply) => {
    if (!state.botReady) {
      return reply.code(503).send({
        ok: false,
        botReady: false
      });
    }
    return {
      ok: true,
      botReady: true,
      tmuxSessionName: config.tmuxSessionName,
      activeBots: activeBotCount(state, deps.runtimeManager)
    };
  });

  if (deps.configStore) {
    registerManagementRoutes(server, deps.configStore, state, deps.runtimeManager);
  }

  return server;
}

function activeBotCount(state: RuntimeState, runtimeManager?: Pick<BotRuntimeControl, "activeCount">): number {
  return runtimeManager?.activeCount() ?? state.activeBots ?? 0;
}

export async function startServer(
  config: Config,
  state: RuntimeState,
  deps: ServerDeps = {}
): Promise<FastifyInstance> {
  const server = createServer(config, state, deps);
  await server.listen({ host: config.httpHost, port: config.httpPort });
  return server;
}

function registerManagementRoutes(
  server: FastifyInstance,
  store: SqliteConfigStore,
  state: RuntimeState,
  runtimeManager?: BotRuntimeControl
): void {
  server.get("/api/bots", async () => ({
    bots: store.listBots().map(toPublicBotConfig)
  }));

  server.get("/api/bots/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bot = store.getBot(id);
    if (!bot) return reply.code(404).send({ error: "Bot not found" });
    return toBotStatusResponse(bot, state, runtimeManager);
  });

  server.post("/api/bots/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bot = store.getBot(id);
    if (!bot) return reply.code(404).send({ error: "Bot not found" });
    if (!bot.telegramBotToken) return reply.code(400).send({ error: "Telegram bot token is not configured" });
    return {
      ...(await testTelegramBotToken(bot.telegramBotToken)),
      runtimeRunning: runtimeManager?.getBotStatus(id).running ?? false
    };
  });

  server.get("/api/bots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bot = store.getBot(id);
    if (!bot) return reply.code(404).send({ error: "Bot not found" });
    return toPublicBotConfig(bot);
  });

  server.post("/api/bots", async (request, reply) => {
    const input = normalizeBotInput(request.body);
    if (!input.ok) return reply.code(400).send({ error: input.error });
    try {
      const bot = store.createBot(input.value);
      let runtimeAction: RuntimeAction = "none";
      let runtimeApplied = false;
      if (runtimeManager && bot.enabled) {
        try {
          await runtimeManager.startBot(bot);
          runtimeAction = "started";
          runtimeApplied = true;
        } catch (error) {
          store.deleteBot(bot.id);
          throw error;
        }
        state.activeBots = runtimeManager.activeCount();
      }
      return reply.code(201).send(toBotMutationResponse(bot, state, runtimeAction, runtimeApplied));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.patch("/api/bots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = normalizeBotPatch(request.body);
    if (!patch.ok) return reply.code(400).send({ error: patch.error });
    const previous = store.getBot(id);
    if (!previous) return reply.code(404).send({ error: "Bot not found" });
    try {
      const bot = store.updateBot(id, patch.value);
      if (!bot) return reply.code(404).send({ error: "Bot not found" });
      let runtimeAction: RuntimeAction = "none";
      let runtimeApplied = false;
      if (runtimeManager) {
        try {
          if (bot.enabled) {
            await runtimeManager.restartBot(bot);
            runtimeAction = "restarted";
          } else {
            await runtimeManager.stopBot(bot.id);
            runtimeAction = "stopped";
          }
        } catch (error) {
          store.updateBot(id, previous);
          await restoreRuntime(previous, runtimeManager, state);
          throw error;
        }
        state.activeBots = runtimeManager.activeCount();
        runtimeApplied = true;
      }
      return toBotMutationResponse(bot, state, runtimeAction, runtimeApplied);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.delete("/api/bots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bot = store.getBot(id);
    if (!bot) return reply.code(404).send({ error: "Bot not found" });
    if (runtimeManager) {
      await runtimeManager.stopBot(id);
      state.activeBots = runtimeManager.activeCount();
    }
    store.deleteBot(id);
    return {
      ok: true,
      runtimeApplied: Boolean(runtimeManager),
      runtimeAction: runtimeManager ? "stopped" : "none",
      activeBots: state.activeBots ?? 0
    };
  });
}

async function restoreRuntime(
  previous: BotConfigRecord,
  runtimeManager: BotRuntimeControl,
  state: RuntimeState
): Promise<void> {
  try {
    if (previous.enabled) {
      await runtimeManager.restartBot(previous);
    } else {
      await runtimeManager.stopBot(previous.id);
    }
  } catch (error) {
    console.error(
      `Failed to restore bot runtime ${previous.id} after management update failure:`,
      error
    );
  } finally {
    state.activeBots = runtimeManager.activeCount();
  }
}

function toBotMutationResponse(
  bot: BotConfigRecord,
  state: RuntimeState,
  runtimeAction: RuntimeAction,
  runtimeApplied: boolean
): BotMutationResponse {
  return {
    ...toPublicBotConfig(bot),
    runtimeAction,
    runtimeApplied,
    activeBots: state.activeBots ?? 0
  };
}

function toBotStatusResponse(
  bot: BotConfigRecord,
  state: RuntimeState,
  runtimeManager?: BotRuntimeControl
): BotStatusResponse {
  const publicBot = toPublicBotConfig(bot);
  return {
    id: publicBot.id,
    enabled: publicBot.enabled,
    agentType: publicBot.agentType,
    telegramBotTokenSet: publicBot.telegramBotTokenSet,
    openaiApiKeySet: publicBot.openaiApiKeySet,
    allowedUsers: publicBot.allowedUsers,
    tmuxSessionName: publicBot.tmuxSessionName,
    runtime: runtimeManager?.getBotStatus(bot.id) ?? {
      id: bot.id,
      running: false,
      startedAt: null,
      stoppedAt: null,
      lastError: null
    },
    activeBots: activeBotCount(state, runtimeManager)
  };
}

async function testTelegramBotToken(token: string): Promise<Omit<BotConnectivityResponse, "runtimeRunning">> {
  const startedAt = Date.now();
  const timeoutMs = 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const proxy = proxyConfigLabel(readHttpProxyConfig());
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: controller.signal
    });
    const data = (await response.json()) as TelegramGetMeResponse;
    const latencyMs = Date.now() - startedAt;
    if (!response.ok || !data.ok || !data.result) {
      return {
        ok: false,
        latencyMs,
        proxy,
        botId: null,
        username: null,
        firstName: null,
        error: data.description ?? `Telegram API returned HTTP ${response.status}`
      };
    }
    return {
      ok: true,
      latencyMs,
      proxy,
      botId: data.result.id,
      username: data.result.username ?? null,
      firstName: data.result.first_name ?? null,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      proxy,
      botId: null,
      username: null,
      firstName: null,
      error: telegramTestErrorMessage(error, timeoutMs)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function telegramTestErrorMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Telegram API timeout after ${Math.round(timeoutMs / 1000)}s. Check HTTPS_PROXY/HTTP_PROXY and local proxy port.`;
  }
  return error instanceof Error ? error.message : String(error);
}

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name?: string;
    username?: string;
  };
  description?: string;
}

type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function normalizeBotInput(value: unknown): NormalizeResult<BotConfigInput> {
  if (!isRecord(value)) return { ok: false, error: "Expected JSON object" };
  const name = stringValue(value.name);
  const telegramBotToken = stringValue(value.telegramBotToken);
  const allowedUsers = numberArray(value.allowedUsers);
  if (!name) return { ok: false, error: "name is required" };
  if (!telegramBotToken) return { ok: false, error: "telegramBotToken is required" };
  if (allowedUsers.length === 0) return { ok: false, error: "allowedUsers is required" };
  return {
    ok: true,
    value: stripUndefined({
      id: optionalString(value.id),
      name,
      telegramBotToken,
      allowedUsers,
      tmuxSessionName: optionalString(value.tmuxSessionName),
      agentType: optionalAgentType(value.agentType),
      claudeCommand: optionalString(value.claudeCommand),
      openaiApiKey: optionalString(value.openaiApiKey),
      openaiBaseUrl: optionalString(value.openaiBaseUrl),
      monitorPollInterval: optionalNumber(value.monitorPollInterval),
      showUserMessages: optionalBoolean(value.showUserMessages),
      showToolCalls: optionalBoolean(value.showToolCalls),
      showHiddenDirs: optionalBoolean(value.showHiddenDirs),
      enabled: optionalBoolean(value.enabled)
    }) as BotConfigInput
  };
}

function normalizeBotPatch(value: unknown): NormalizeResult<BotConfigPatch> {
  if (!isRecord(value)) return { ok: false, error: "Expected JSON object" };
  return {
    ok: true,
    value: stripUndefined({
      name: optionalString(value.name),
      telegramBotToken: optionalString(value.telegramBotToken),
      allowedUsers: value.allowedUsers === undefined ? undefined : numberArray(value.allowedUsers),
      tmuxSessionName: optionalString(value.tmuxSessionName),
      claudeCommand: optionalString(value.claudeCommand),
      openaiApiKey: optionalString(value.openaiApiKey),
      openaiBaseUrl: optionalString(value.openaiBaseUrl),
      monitorPollInterval: optionalNumber(value.monitorPollInterval),
      showUserMessages: optionalBoolean(value.showUserMessages),
      showToolCalls: optionalBoolean(value.showToolCalls),
      showHiddenDirs: optionalBoolean(value.showHiddenDirs),
      enabled: optionalBoolean(value.enabled)
    }) as BotConfigPatch
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result ? result : undefined;
}

function optionalAgentType(value: unknown): "claude" | "codex" | undefined {
  if (value === undefined) return undefined;
  return value === "codex" ? "codex" : "claude";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isSafeInteger);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
