import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/agent-connect/config.js";
import { SqliteConfigStore } from "../src/agent-connect/configStore.js";
import { type BotRuntimeControl, createServer } from "../src/agent-connect/server.js";

function testConfig(): { config: Config; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-connect-server-test-"));
  const config = new Config({
    TELEGRAM_BOT_TOKEN: "test:token",
    ALLOWED_USERS: "12345",
    AGENT_CONNECT_DIR: dir
  });
  return {
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fastify server", () => {
  it("serves health and readiness routes", async () => {
    const { config, cleanup } = testConfig();
    const state = {
      startedAt: "2026-05-16T00:00:00.000Z",
      botReady: false
    };
    const server = createServer(config, state);

    try {
      const health = await server.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, service: "agent-connect" });

      const notReady = await server.inject({ method: "GET", url: "/readyz" });
      expect(notReady.statusCode).toBe(503);

      state.botReady = true;
      const ready = await server.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ ok: true, botReady: true });
    } finally {
      await server.close();
      cleanup();
    }
  });

  it("serves bot management routes when a config store is registered", async () => {
    const { config, cleanup } = testConfig();
    const store = new SqliteConfigStore(join(config.configDir, "agent-connect.sqlite"));
    const server = createServer(
      config,
      {
        startedAt: "2026-05-16T00:00:00.000Z",
        botReady: true,
        activeBots: 0
      },
      { configStore: store }
    );

    try {
      const create = await server.inject({
        method: "POST",
        url: "/api/bots",
        payload: {
          id: "ops",
          name: "Ops Bot",
          telegramBotToken: "secret-token",
          allowedUsers: [100, 200],
          agentType: "codex",
          tmuxSessionName: "agent-connect-ops",
          enabled: true
        }
      });
      expect(create.statusCode).toBe(201);
      expect(create.json()).toMatchObject({
        id: "ops",
        name: "Ops Bot",
        telegramBotTokenSet: true,
        allowedUsers: [100, 200],
        agentType: "codex",
        claudeCommand: "codex --yolo",
        tmuxSessionName: "agent-connect-ops",
        enabled: true
      });
      expect(create.body).not.toContain("secret-token");

      const list = await server.inject({ method: "GET", url: "/api/bots" });
      expect(list.statusCode).toBe(200);
      expect(list.json().bots).toHaveLength(1);

      const update = await server.inject({
        method: "PATCH",
        url: "/api/bots/ops",
        payload: {
          name: "Ops Bot Updated",
          allowedUsers: [300],
          enabled: false
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({
        id: "ops",
        name: "Ops Bot Updated",
        allowedUsers: [300],
        enabled: false
      });

      const remove = await server.inject({ method: "DELETE", url: "/api/bots/ops" });
      expect(remove.statusCode).toBe(200);
      expect(remove.json()).toMatchObject({ ok: true, runtimeApplied: false, runtimeAction: "none" });

      const missing = await server.inject({ method: "GET", url: "/api/bots/ops" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await server.close();
      store.close();
      cleanup();
    }
  });

  it("syncs running bot runtimes from management route changes", async () => {
    const { config, cleanup } = testConfig();
    const store = new SqliteConfigStore(join(config.configDir, "agent-connect.sqlite"));
    const calls: string[] = [];
    let active = 0;
    const runtimeManager: BotRuntimeControl = {
      activeCount: () => active,
      getBotStatus: (id) => ({
        id,
        running: active > 0,
        startedAt: active > 0 ? "2026-05-16T00:00:01.000Z" : null,
        stoppedAt: active > 0 ? null : "2026-05-16T00:00:02.000Z",
        lastError: null
      }),
      startBot: async (record) => {
        calls.push(`start:${record.id}`);
        active = 1;
      },
      restartBot: async (record) => {
        calls.push(`restart:${record.id}`);
        active = 1;
      },
      hasCrashedBot: () => false,
      stopBot: async (id) => {
        calls.push(`stop:${id}`);
        active = 0;
      }
    };
    const state = {
      startedAt: "2026-05-16T00:00:00.000Z",
      botReady: true,
      activeBots: 0
    };
    const server = createServer(config, state, { configStore: store, runtimeManager });

    try {
      const create = await server.inject({
        method: "POST",
        url: "/api/bots",
        payload: {
          id: "ops",
          name: "Ops Bot",
          telegramBotToken: "secret-token",
          allowedUsers: [100],
          enabled: true
        }
      });
      expect(create.statusCode).toBe(201);
      expect(calls).toEqual(["start:ops"]);
      expect(state.activeBots).toBe(1);
      expect(create.json()).toMatchObject({
        runtimeApplied: true,
        runtimeAction: "started",
        activeBots: 1
      });

      const status = await server.inject({ method: "GET", url: "/api/bots/ops/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        id: "ops",
        enabled: true,
        telegramBotTokenSet: true,
        runtime: {
          id: "ops",
          running: true,
          lastError: null
        },
        activeBots: 1
      });

      const disable = await server.inject({
        method: "PATCH",
        url: "/api/bots/ops",
        payload: { enabled: false }
      });
      expect(disable.statusCode).toBe(200);
      expect(calls).toEqual(["start:ops", "stop:ops"]);
      expect(state.activeBots).toBe(0);

      const enable = await server.inject({
        method: "PATCH",
        url: "/api/bots/ops",
        payload: { enabled: true }
      });
      expect(enable.statusCode).toBe(200);
      expect(calls).toEqual(["start:ops", "stop:ops", "restart:ops"]);
      expect(state.activeBots).toBe(1);

      const remove = await server.inject({ method: "DELETE", url: "/api/bots/ops" });
      expect(remove.statusCode).toBe(200);
      expect(calls).toEqual(["start:ops", "stop:ops", "restart:ops", "stop:ops"]);
      expect(state.activeBots).toBe(0);
    } finally {
      await server.close();
      store.close();
      cleanup();
    }
  });

  it("rolls back bot config and runtime when a live update fails", async () => {
    const { config, cleanup } = testConfig();
    const store = new SqliteConfigStore(join(config.configDir, "agent-connect.sqlite"));
    store.createBot({
      id: "ops",
      name: "Ops Bot",
      telegramBotToken: "secret-token",
      allowedUsers: [100],
      enabled: true
    });
    const calls: string[] = [];
    const runtimeManager: BotRuntimeControl = {
      activeCount: () => 1,
      getBotStatus: (id) => ({
        id,
        running: true,
        startedAt: "2026-05-16T00:00:01.000Z",
        stoppedAt: null,
        lastError: null
      }),
      startBot: async () => {},
      restartBot: async (record) => {
        calls.push(`restart:${record.name}`);
        if (record.name === "Broken Bot") throw new Error("runtime failed");
      },
      hasCrashedBot: () => false,
      stopBot: async (id) => {
        calls.push(`stop:${id}`);
      }
    };
    const server = createServer(
      config,
      {
        startedAt: "2026-05-16T00:00:00.000Z",
        botReady: true,
        activeBots: 1
      },
      { configStore: store, runtimeManager }
    );

    try {
      const update = await server.inject({
        method: "PATCH",
        url: "/api/bots/ops",
        payload: { name: "Broken Bot" }
      });

      expect(update.statusCode).toBe(400);
      expect(update.json()).toMatchObject({ error: "runtime failed" });
      expect(store.getBot("ops")).toMatchObject({ name: "Ops Bot" });
      expect(calls).toEqual(["restart:Broken Bot", "restart:Ops Bot"]);
    } finally {
      await server.close();
      store.close();
      cleanup();
    }
  });

  it("tests Telegram connectivity without exposing the token", async () => {
    const { config, cleanup } = testConfig();
    const store = new SqliteConfigStore(join(config.configDir, "agent-connect.sqlite"));
    store.createBot({
      id: "ops",
      name: "Ops Bot",
      telegramBotToken: "secret-token",
      allowedUsers: [100],
      enabled: false
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.telegram.org/botsecret-token/getMe");
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 42,
              is_bot: true,
              first_name: "Ops",
              username: "ops_bot"
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const runtimeManager: BotRuntimeControl = {
      activeCount: () => 0,
      getBotStatus: (id) => ({
        id,
        running: false,
        startedAt: null,
        stoppedAt: null,
        lastError: null
      }),
      startBot: async () => {},
      restartBot: async () => {},
      hasCrashedBot: () => false,
      stopBot: async () => {}
    };
    const server = createServer(
      config,
      {
        startedAt: "2026-05-16T00:00:00.000Z",
        botReady: true,
        activeBots: 0
      },
      { configStore: store, runtimeManager }
    );

    try {
      const response = await server.inject({ method: "POST", url: "/api/bots/ops/test" });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("secret-token");
      expect(response.json()).toMatchObject({
        ok: true,
        botId: 42,
        username: "ops_bot",
        firstName: "Ops",
        runtimeRunning: false,
        proxy: expect.any(String),
        error: null
      });
      expect(response.json().latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
      store.close();
      cleanup();
    }
  });
});
