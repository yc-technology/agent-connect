import { describe, test, expect } from "vitest";
import Fastify from "fastify";
import { registerHookEndpoint } from "../src/agent-connect/server.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

function setup(): {
  fastify: ReturnType<typeof Fastify>;
  registry: SessionRegistry;
  dispatched: unknown[];
} {
  const registry = new SessionRegistry(inMemoryDb());
  const dispatched: unknown[] = [];
  const router = new HookRouter({
    registry,
    dispatcher: async (windowId, entries) => {
      dispatched.push({ windowId, count: entries.length });
    },
    agentType: "claude"
  });
  const routers = new Map<string, HookRouter>();
  routers.set("test-session", router);
  const fastify = Fastify();
  registerHookEndpoint(fastify, (tmuxSession) => routers.get(tmuxSession) ?? null);
  return { fastify, registry, dispatched };
}

describe("Fastify /hook/events", () => {
  test("returns 202 immediately", async () => {
    const { fastify } = setup();
    const reply = await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: envelope("SessionStart", { session_id: "S", transcript_path: "/p", cwd: "/a" })
    });
    expect(reply.statusCode).toBe(202);
  });

  test("processes envelope asynchronously and updates registry", async () => {
    const { fastify, registry } = setup();
    await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: envelope(
        "SessionStart",
        { session_id: "S", transcript_path: "/p", cwd: "/a" },
        { window_id: "@7" }
      )
    });
    // The endpoint returns 202 immediately and processes the envelope
    // asynchronously (onSessionStart awaits an fs.stat for the EOF-skip
    // offset before registerSession). Poll for the registry row instead of
    // waiting a FIXED number of microtask cycles — a fixed wait is the
    // "setTimeout and hope" anti-pattern that passes on fast dev machines
    // but races on slow CI (the actual failure: `expected undefined to be
    // 'S'`). Per CLAUDE.md's testing guidance, loop until the state appears.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && registry.getSessionByWindow("@7") === null) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.getSessionByWindow("@7")?.session_id).toBe("S");
  });

  test("returns 400 on malformed body", async () => {
    const { fastify } = setup();
    const reply = await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: { foo: "bar" }
    });
    expect(reply.statusCode).toBe(400);
  });

  test("silently drops envelope for unknown tmux_session", async () => {
    const { fastify, dispatched } = setup();
    const reply = await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: envelope("SessionStart", {}, { tmux_session: "other" })
    });
    expect(reply.statusCode).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(dispatched).toEqual([]);
  });
});
