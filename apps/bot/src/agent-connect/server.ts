import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
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
import type { HookRouter } from "./hookRouter.js";
import type { HookEnvelope } from "./hookTypes.js";
import { logger } from "./logger.js";
import type { OutboundDispatcher } from "./outboundDispatcher.js";
import { proxyConfigLabel, readHttpProxyConfig } from "./proxy.js";

export type HookRouterLookup = (tmuxSession: string) => HookRouter | null;
export type OutboundLookup = (tmuxSession: string) => OutboundDispatcher | null;

export function registerHookEndpoint(fastify: FastifyInstance, lookup: HookRouterLookup): void {
  fastify.post("/hook/events", async (req, reply) => {
    const body = req.body as Partial<HookEnvelope> | undefined;
    if (
      !body ||
      typeof body.tmux_session !== "string" ||
      typeof body.window_id !== "string" ||
      typeof body.window_name !== "string" ||
      typeof body.payload !== "object" ||
      body.payload === null
    ) {
      return reply.code(400).send({ error: "invalid envelope" });
    }
    const router = lookup(body.tmux_session);
    if (router) {
      const env = body as HookEnvelope;
      setImmediate(() => {
        router.dispatch(env).catch((err) =>
          logger().warn(
            { windowId: env.window_id, sessionId: env.payload.session_id, event: env.payload.hook_event_name, err },
            "hookEndpoint dispatch failed"
          )
        );
      });
    }
    return reply.code(202).send();
  });
}

export interface RuntimeState {
  startedAt: string;
  botReady: boolean;
  activeBots?: number;
}

export interface ServerDeps {
  configStore?: SqliteConfigStore;
  runtimeManager?: BotRuntimeControl;
  hookRouterLookup?: HookRouterLookup;
  outboundLookup?: OutboundLookup;
}

export function registerSendFileEndpoint(fastify: FastifyInstance, lookup: OutboundLookup): void {
  fastify.post("/bot/send-file", async (req, reply) => {
    const body = req.body as
      | {
          path?: unknown;
          windowId?: unknown;
          tmuxSession?: unknown;
          caption?: unknown;
        }
      | undefined;
    if (
      !body ||
      typeof body.path !== "string" ||
      typeof body.windowId !== "string" ||
      typeof body.tmuxSession !== "string"
    ) {
      return reply
        .code(400)
        .send({ ok: false, error: "path, windowId, tmuxSession are required strings" });
    }
    const caption = typeof body.caption === "string" ? body.caption : null;
    const dispatcher = lookup(body.tmuxSession);
    if (!dispatcher) {
      return reply
        .code(404)
        .send({ ok: false, error: `no bot registered for tmux session ${body.tmuxSession}` });
    }
    const result = await dispatcher.sendFile({
      path: body.path,
      windowId: body.windowId,
      caption
    });
    return reply.code(result.status).send(result);
  });
}

export interface BotRuntimeControl {
  activeCount(): number;
  getBotStatus(id: string): BotRuntimeStatus;
  startBot(record: BotConfigRecord): Promise<void>;
  restartBot(record: BotConfigRecord): Promise<void>;
  stopBot(id: string): Promise<void>;
  // Returns true if any bot's grammy runtime crashed since its last
  // successful start (i.e. TG polling is dead even though the HTTP server
  // is still up). Surfaced via /healthz → supervisor restart.
  hasCrashedBot(): boolean;
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
  // Reuse the shared pino logger so HTTP request logs land in the same file
  // (and rotate the same way) as the rest of the bot. Fastify 5: pass
  // `loggerInstance` (pre-built pino) NOT `logger` (which expects options).
  // Test mode uses a silent pino instead of `logger: false` so the Fastify
  // return type stays uniform across branches.
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const fastifyLogger = isTest ? pino({ level: "silent" }) : logger().child({ component: "http" });
  // Cast away the specialized Logger generic that Fastify infers from a
  // typed loggerInstance — downstream helpers (registerHookEndpoint,
  // registerManagementRoutes) expect the default FastifyBaseLogger generic.
  // pino is structurally compatible at runtime; the only difference is
  // `msgPrefix?` vs `msgPrefix` (pino marks it optional).
  const server = Fastify({ loggerInstance: fastifyLogger }) as unknown as FastifyInstance;

  server.get("/healthz", async (_req, reply) => {
    // 503 when ANY bot's grammy runtime crashed since last start. The HTTP
    // server staying up while TG polling is dead is the exact scenario the
    // supervisor's healthz check needs to catch — pre-fix it would happily
    // see 200 for 12+ hours while users got silence on Telegram.
    const crashed = deps.runtimeManager?.hasCrashedBot() ?? false;
    if (crashed) {
      return reply.code(503).send({
        ok: false,
        service: "agent-connect",
        startedAt: state.startedAt,
        activeBots: activeBotCount(state, deps.runtimeManager),
        reason: "bot runtime crashed (TG polling dead) — supervisor should restart"
      });
    }
    return {
      ok: true,
      service: "agent-connect",
      startedAt: state.startedAt,
      activeBots: activeBotCount(state, deps.runtimeManager)
    };
  });

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

  if (deps.hookRouterLookup) {
    registerHookEndpoint(server, deps.hookRouterLookup);
  }

  if (deps.outboundLookup) {
    registerSendFileEndpoint(server, deps.outboundLookup);
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
  await registerWebStaticIfPresent(server);
  await server.listen({ host: config.httpHost, port: config.httpPort });
  return server;
}

/**
 * Serve the built React console (apps/web/dist, copied into
 * apps/bot/dist/web/ at build time by scripts/copy-web-dist.mjs) from
 * the Fastify root. When the bundle isn't present — typical for
 * `pnpm dev:bot` invocations where vite is serving the web on :5173
 * separately — skip registration silently; the API still works.
 */
async function registerWebStaticIfPresent(server: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, "..", "..", "web");
  if (!existsSync(join(webRoot, "index.html"))) return;
  await server.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    // Let the SPA's index.html handle deep links — Fastify-static returns
    // index.html for unknown paths under the prefix.
    wildcard: true
  });
  logger().info({ webRoot }, "serving web console statically from bot dist");
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
    logger().error(
      { botId: previous.id, err: error },
      "failed to restore bot runtime after management update failure"
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
