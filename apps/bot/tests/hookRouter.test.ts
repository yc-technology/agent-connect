import { describe, test, expect, vi } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";
import { writeFakeTranscript } from "./helpers/transcriptFixtures.js";
import type { Dispatcher } from "../src/agent-connect/drainTranscript.js";

function setup(): {
  registry: SessionRegistry;
  router: HookRouter;
  dispatched: Array<{ windowId: string; count: number }>;
} {
  const registry = new SessionRegistry(inMemoryDb());
  const dispatched: Array<{ windowId: string; count: number }> = [];
  const dispatcher: Dispatcher = async (windowId, entries) => {
    dispatched.push({ windowId, count: entries.length });
  };
  const router = new HookRouter({ registry, dispatcher, agentType: "claude" });
  return { registry, router, dispatched };
}

describe("HookRouter SessionStart", () => {
  test("registers window + session", async () => {
    const { registry, router } = setup();
    await router.dispatch(
      envelope(
        "SessionStart",
        {
          session_id: "S1",
          transcript_path: "/tmp/S1.jsonl",
          cwd: "/proj",
          source: "startup"
        },
        { window_id: "@0", window_name: "proj" }
      )
    );
    const win = registry.listLiveWindows();
    expect(win).toMatchObject([{ window_id: "@0", display_name: "proj", cwd: "/proj" }]);
    expect(registry.getSession("S1")).toMatchObject({
      window_id: "@0",
      transcript_path: "/tmp/S1.jsonl",
      source: "startup",
      last_byte_offset: 0
    });
  });

  test("SessionStart for same window replaces session", async () => {
    const { registry, router } = setup();
    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "S1", transcript_path: "/p1", cwd: "/a" },
        { window_id: "@0" }
      )
    );
    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "S2", transcript_path: "/p2", cwd: "/a" },
        { window_id: "@0" }
      )
    );
    expect(registry.getSession("S1")).toBeNull();
    expect(registry.getSessionByWindow("@0")?.session_id).toBe("S2");
  });

  test("ignores unknown hook event names without throwing", async () => {
    const { router } = setup();
    await router.dispatch(envelope("InstructionsLoaded" as never));
  });
});

describe("HookRouter drain-triggering events", () => {
  test("Stop drains transcript and dispatches", async () => {
    const { router, dispatched } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }
    ]);
    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "S", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );
    await router.dispatch(
      envelope(
        "Stop",
        { session_id: "S", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );
    expect(dispatched).toContainEqual({ windowId: "@0", count: 1 });
  });

  test("PostToolUse, PostToolBatch, PostToolUseFailure, UserPromptSubmit, SessionEnd all trigger drain", async () => {
    for (const event of [
      "PostToolUse",
      "PostToolBatch",
      "PostToolUseFailure",
      "UserPromptSubmit",
      "SessionEnd"
    ] as const) {
      const { router, dispatched } = setup();
      const path = await writeFakeTranscript([
        { type: "assistant", message: { content: [{ type: "text", text: `via-${event}` }] } }
      ]);
      await router.dispatch(
        envelope(
          "SessionStart",
          { session_id: "S", transcript_path: path, cwd: "/a" },
          { window_id: "@0" }
        )
      );
      const before = dispatched.length;
      await router.dispatch(
        envelope(
          event,
          { session_id: "S", transcript_path: path, cwd: "/a" },
          { window_id: "@0" }
        )
      );
      expect(dispatched.length).toBeGreaterThan(before);
    }
  });

  test("SessionEnd also deletes the session row after drain", async () => {
    const { registry, router } = setup();
    const path = await writeFakeTranscript([]);
    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "S", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );
    await router.dispatch(
      envelope(
        "SessionEnd",
        { session_id: "S", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );
    expect(registry.getSession("S")).toBeNull();
  });

  test("event for unregistered session does not throw", async () => {
    const { router, dispatched } = setup();
    await router.dispatch(envelope("Stop", { session_id: "UNKNOWN" }, { window_id: "@9" }));
    expect(dispatched).toEqual([]);
  });
});

describe("HookRouter records lastEvent on every dispatched event", () => {
  test("each accepted event updates registry.getLastEvent for its window", async () => {
    const { registry, router } = setup();
    const path = await writeFakeTranscript([]);
    await router.dispatch(
      envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    expect(registry.getLastEvent("@0")?.event).toBe("SessionStart");
    await router.dispatch(
      envelope("PostToolUse", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    expect(registry.getLastEvent("@0")?.event).toBe("PostToolUse");
    await router.dispatch(
      envelope("Stop", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    expect(registry.getLastEvent("@0")?.event).toBe("Stop");
  });

  test("foreign-agent events do NOT update lastEvent", async () => {
    const { registry, router } = setup(); // agentType claude
    await router.dispatch(
      envelope(
        "SessionStart",
        {
          session_id: "X",
          transcript_path: "/Users/x/.codex/sessions/foreign.jsonl",
          cwd: "/a"
        },
        { window_id: "@0" }
      )
    );
    expect(registry.getLastEvent("@0")).toBeNull();
  });
});

describe("HookRouter foreign-agent filter", () => {
  test("claude bot ignores SessionStart with codex transcript_path", async () => {
    const { registry, router } = setup();
    await router.dispatch(
      envelope(
        "SessionStart",
        {
          session_id: "C1",
          transcript_path: "/Users/x/.claude/projects/-Users-x-proj/abc.jsonl",
          cwd: "/Users/x/proj"
        },
        { window_id: "@0" }
      )
    );
    expect(registry.getSessionByWindow("@0")?.session_id).toBe("C1");
    await router.dispatch(
      envelope(
        "SessionStart",
        {
          session_id: "X1",
          transcript_path: "/Users/x/.codex/sessions/2026/05/18/rollout-X1.jsonl",
          cwd: "/Users/x/proj"
        },
        { window_id: "@0" }
      )
    );
    expect(registry.getSessionByWindow("@0")?.session_id).toBe("C1");
  });

  test("claude bot ignores Stop with codex transcript_path", async () => {
    const { registry, router, dispatched } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "real" }] } }
    ]);
    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "C1", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );
    const before = dispatched.length;
    await router.dispatch(
      envelope(
        "Stop",
        {
          session_id: "X1",
          transcript_path: "/Users/x/.codex/sessions/foreign.jsonl",
          cwd: "/a"
        },
        { window_id: "@0" }
      )
    );
    expect(dispatched.length).toBe(before);
    expect(registry.getSessionByWindow("@0")?.session_id).toBe("C1");
  });
});

describe("HookRouter onTurnEnd", () => {
  function setupWithTurn() {
    const registry = new SessionRegistry(inMemoryDb());
    const dispatched: Array<{ windowId: string; count: number }> = [];
    const dispatcher: Dispatcher = async (windowId, entries) => {
      dispatched.push({ windowId, count: entries.length });
    };
    const turnEnds: Array<{ windowId: string; outcome: string }> = [];
    const onTurnEnd = async (windowId: string, outcome: string) => {
      turnEnds.push({ windowId, outcome });
    };
    const router = new HookRouter({ registry, dispatcher, agentType: "claude", onTurnEnd });
    return { registry, router, dispatched, turnEnds };
  }

  test("Stop fires onTurnEnd with success outcome AFTER drain completes", async () => {
    const { router, dispatched, turnEnds } = setupWithTurn();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }
    ]);
    await router.dispatch(
      envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    expect(turnEnds).toEqual([]);
    await router.dispatch(
      envelope("Stop", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    expect(dispatched).toContainEqual({ windowId: "@0", count: 1 });
    expect(turnEnds).toEqual([{ windowId: "@0", outcome: "success" }]);
  });

  test("PostToolUse / UserPromptSubmit / SessionStart never fire onTurnEnd", async () => {
    const { router, turnEnds } = setupWithTurn();
    const path = await writeFakeTranscript([]);
    await router.dispatch(envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    await router.dispatch(envelope("PostToolUse", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    await router.dispatch(envelope("UserPromptSubmit", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    expect(turnEnds).toEqual([]);
  });

  test("onTurnEnd throw is swallowed and does not break further dispatch", async () => {
    const registry = new SessionRegistry(inMemoryDb());
    const dispatched: Array<{ windowId: string; count: number }> = [];
    const onTurnEnd = async () => {
      throw new Error("reaction api down");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const router = new HookRouter({
        registry,
        dispatcher: async (w, e) => {
          dispatched.push({ windowId: w, count: e.length });
        },
        agentType: "claude",
        onTurnEnd
      });
      const path = await writeFakeTranscript([
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }
      ]);
      await router.dispatch(envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
      await router.dispatch(envelope("Stop", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
      // dispatch is still reachable for next event
      await router.dispatch(envelope("Stop", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
      expect(warn).toHaveBeenCalledWith("[hookRouter onTurnEnd]", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("HookRouter lazy registration", () => {
  test("Stop for unknown session lazily registers + drains transcript", async () => {
    const { registry, router, dispatched } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "first reply" }] } }
    ]);
    // No SessionStart fired — simulate bot starting up after Claude already running,
    // or user binding a topic to a pre-existing tmux window.
    await router.dispatch(
      envelope(
        "Stop",
        { session_id: "LATE", transcript_path: path, cwd: "/a" },
        { window_id: "@0", window_name: "proj" }
      )
    );
    expect(registry.getSession("LATE")).toMatchObject({ window_id: "@0", source: "lazy" });
    expect(registry.listLiveWindows()).toMatchObject([{ window_id: "@0", display_name: "proj" }]);
    expect(dispatched).toContainEqual({ windowId: "@0", count: 1 });
  });

  test("lazy register does not double-register on next event", async () => {
    const { registry, router } = setup();
    const path = await writeFakeTranscript([]);
    await router.dispatch(
      envelope("Stop", { session_id: "L1", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    const firstStarted = registry.getSession("L1")?.started_at;
    expect(firstStarted).toBeTypeOf("number");
    await new Promise((r) => setTimeout(r, 5));
    await router.dispatch(
      envelope("PostToolUse", { session_id: "L1", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    expect(registry.getSession("L1")?.started_at).toBe(firstStarted);
  });
});

describe("HookRouter per-window queue", () => {
  test("SessionStart completes before subsequent Stop even when dispatched out of order", async () => {
    const { registry, router } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } }
    ]);
    const startP = router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "S", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );
    const stopP = router.dispatch(
      envelope("Stop", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" })
    );
    await Promise.all([startP, stopP]);
    expect(registry.getSession("S")).not.toBeNull();
    expect(registry.getSession("S")!.last_byte_offset).toBeGreaterThan(0);
  });

  test("different windows process in parallel", async () => {
    const { registry, router } = setup();
    const path1 = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "w0" }] } }
    ]);
    const path2 = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "w1" }] } }
    ]);
    await Promise.all([
      router.dispatch(
        envelope(
          "SessionStart",
          { session_id: "A", transcript_path: path1, cwd: "/a" },
          { window_id: "@0" }
        )
      ),
      router.dispatch(
        envelope(
          "SessionStart",
          { session_id: "B", transcript_path: path2, cwd: "/b" },
          { window_id: "@1" }
        )
      )
    ]);
    expect(registry.getSession("A")).not.toBeNull();
    expect(registry.getSession("B")).not.toBeNull();
  });
});
