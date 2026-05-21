import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager, WindowState } from "../src/agent-connect/session.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-connect-session-test-"));
}

function makeManager(dir: string, loadState = false): SessionManager {
  return new SessionManager({
    config: {
      stateFile: join(dir, "state.json"),
      sessionMapFile: join(dir, "session_map.json"),
      tmuxSessionName: "agent-connect",
      claudeProjectsPath: join(dir, "projects"),
      codexHomePath: join(dir, "codex"),
      agentType: "claude"
    },
    loadState
  });
}

function writeJsonlSession(projectsPath: string, cwd: string, sessionId: string, lines: unknown[]): string {
  const manager = new SessionManager({
    config: {
      stateFile: join(projectsPath, "..", "state.json"),
      sessionMapFile: join(projectsPath, "..", "session_map.json"),
      tmuxSessionName: "agent-connect",
      claudeProjectsPath: projectsPath,
      codexHomePath: join(projectsPath, "..", "codex"),
      agentType: "claude"
    },
    loadState: false
  });
  const projectDir = join(projectsPath, manager.encodeCwd(cwd));
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function writeCodexSession(codexHomePath: string, cwd: string, sessionId: string, lines: unknown[]): string {
  const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `rollout-2026-05-17T00-00-00-${sessionId}.jsonl`);
  const sessionMeta = {
    timestamp: "2026-05-17T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd,
      base_instructions: "x".repeat(12_000)
    }
  };
  writeFileSync(file, [sessionMeta, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  mkdirSync(codexHomePath, { recursive: true });
  writeFileSync(
    join(codexHomePath, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Codex summary", updated_at: "2026-05-17T00:00:01.000Z" })}\n`,
    "utf8"
  );
  return file;
}

describe("WindowState", () => {
  it("round trips through legacy state object format", () => {
    const state = WindowState.fromDict({
      session_id: "s1",
      cwd: "/tmp/project",
      window_name: "project"
    });
    expect(state.sessionId).toBe("s1");
    expect(state.toDict()).toEqual({
      session_id: "s1",
      cwd: "/tmp/project",
      window_name: "project"
    });
  });

  it("defaults missing fields", () => {
    expect(WindowState.fromDict({}).toDict()).toEqual({ session_id: "", cwd: "" });
  });
});

describe("SessionManager thread and chat state", () => {
  it("binds, resolves, iterates, and unbinds threads", () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      manager.bindThread(100, 1, "@1");
      manager.bindThread(100, 2, "@2");
      manager.bindThread(200, 3, "@3");
      manager.setTopicProbeMessageId(100, 1, 101);

      expect(manager.getWindowForThread(100, 1)).toBe("@1");
      expect(manager.resolveWindowForThread(100, null)).toBeNull();
      expect(new Set(manager.iterThreadBindings())).toEqual(
        new Set([
          [100, 1, "@1"],
          [100, 2, "@2"],
          [200, 3, "@3"]
        ])
      );

      expect(manager.unbindThread(100, 1)).toBe("@1");
      expect(manager.getWindowForThread(100, 1)).toBeNull();
      expect(manager.getTopicProbeMessageId(100, 1)).toBeNull();
      expect(manager.unbindThread(100, 999)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores group chat ids independently", () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      manager.setGroupChatId(100, 11, -111);
      manager.setGroupChatId(100, 22, -222);
      manager.setGroupChatId(200, 11, -333);

      expect(manager.resolveChatId(100, 11)).toBe(-111);
      expect(manager.resolveChatId(100, 22)).toBe(-222);
      expect(manager.resolveChatId(200, 11)).toBe(-333);
      expect(manager.resolveChatId(100, null)).toBe(100);
      expect(manager.resolveChatId(100, 42)).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-forum thread ids for group chat id (private chat / General topic)", () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      manager.setGroupChatId(100, 0, -999);
      manager.setGroupChatId(100, 1, -888);
      manager.setGroupChatId(100, null, -777);

      expect(manager.groupChatIds).toEqual({});
      expect(manager.resolveChatId(100, 0)).toBe(100);
      expect(manager.resolveChatId(100, 1)).toBe(100);
      expect(manager.resolveChatId(100, null)).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips polluted group_chat_ids entries on load (legacy state.json with userId:0)", () => {
    const dir = tmpDir();
    try {
      const stateFile = join(dir, "state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          group_chat_ids: {
            "100:0": -111,
            "100:1": -222,
            "100:42": -333
          }
        })
      );

      const manager = makeManager(dir, true);
      expect(manager.groupChatIds).toEqual({ "100:42": -333 });
      expect(manager.resolveChatId(100, 0)).toBe(100);
      expect(manager.resolveChatId(100, 1)).toBe(100);
      expect(manager.resolveChatId(100, 42)).toBe(-333);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks display names and window state", () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      expect(manager.getDisplayName("@99")).toBe("@99");
      manager.bindThread(100, 1, "@1", "proj");
      expect(manager.getDisplayName("@1")).toBe("proj");

      const state = manager.getWindowState("@1");
      state.sessionId = "abc";
      manager.updateDisplayName("@1", "new-proj");
      expect(manager.getWindowState("@1").windowName).toBe("new-proj");

      manager.clearWindowSession("@1");
      expect(manager.getWindowState("@1").sessionId).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks tmux window id shape", () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      expect(manager.isWindowId("@0")).toBe(true);
      expect(manager.isWindowId("@12")).toBe(true);
      expect(manager.isWindowId("myproject")).toBe(false);
      expect(manager.isWindowId("@")).toBe(false);
      expect(manager.isWindowId("@abc")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager persistence and session map", () => {
  it("saves and loads legacy-compatible state JSON", () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      manager.bindThread(100, 42, "@3", "proj");
      manager.setGroupChatId(100, 42, -100123);
      manager.setTopicProbeMessageId(100, 42, 777);
      manager.updateUserWindowOffset(100, "@3", 55);
      manager.getWindowState("@3").sessionId = "sid";
      manager.getWindowState("@3").cwd = "/tmp/project";
      manager.saveState();

      const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
        window_states: Record<string, unknown>;
        thread_bindings: Record<string, Record<string, string>>;
        window_display_names: Record<string, string>;
        topic_probe_message_ids: Record<string, number>;
      };
      expect(raw.window_states["@3"]).toMatchObject({
        session_id: "sid",
        cwd: "/tmp/project"
      });
      expect(raw.thread_bindings["100"]?.["42"]).toBe("@3");
      expect(raw.window_display_names["@3"]).toBe("proj");
      expect(raw.topic_probe_message_ids["100:42"]).toBe(777);

      const loaded = makeManager(dir, true);
      expect(loaded.getWindowForThread(100, 42)).toBe("@3");
      expect(loaded.resolveChatId(100, 42)).toBe(-100123);
      expect(loaded.getTopicProbeMessageId(100, 42)).toBe(777);
      expect(loaded.userWindowOffsets[100]?.["@3"]).toBe(55);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads session_map entries and cleans stale window states", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, "session_map.json"),
        JSON.stringify({
          "agent-connect:@1": {
            session_id: "s1",
            cwd: "/tmp/project",
            window_name: "proj"
          },
          "other:@2": {
            session_id: "s2",
            cwd: "/tmp/other"
          }
        }),
        "utf8"
      );
      const manager = makeManager(dir);
      manager.windowStates["@stale"] = new WindowState("old", "/old");
      await manager.loadSessionMap();

      expect(manager.getWindowState("@1")).toMatchObject({
        sessionId: "s1",
        cwd: "/tmp/project",
        windowName: "proj"
      });
      expect(manager.windowStates["@stale"]).toBeUndefined();
      expect(manager.getDisplayName("@1")).toBe("proj");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes session_map before resolving users for a session", async () => {
    const dir = tmpDir();
    try {
      const projectsPath = join(dir, "projects");
      const cwd = "/tmp/project";
      const sessionId = "session-1";
      writeJsonlSession(projectsPath, cwd, sessionId, [
        { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }
      ]);
      writeFileSync(
        join(dir, "session_map.json"),
        JSON.stringify({
          "agent-connect:@1": {
            session_id: sessionId,
            cwd,
            window_name: "proj"
          }
        }),
        "utf8"
      );

      const manager = makeManager(dir);
      manager.bindThread(100, 0, "@1");

      await expect(manager.findUsersForSession(sessionId)).resolves.toEqual([[100, "@1", 0]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager Claude session resolution", () => {
  it("builds paths, reads summaries, lists sessions, and returns history", async () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      const projectsPath = join(dir, "projects");
      const cwd = "/tmp/project";
      const sessionId = "session-1";
      const file = writeJsonlSession(projectsPath, cwd, sessionId, [
        { type: "summary", summary: "Session summary" },
        { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }
      ]);

      expect(manager.buildSessionFilePath(sessionId, cwd)).toBe(file);
      const session = await manager.getSessionDirect(sessionId, cwd);
      expect(session).toMatchObject({
        sessionId,
        summary: "Session summary",
        messageCount: 3,
        filePath: file
      });

      const sessions = await manager.listSessionsForDirectory(cwd);
      expect(sessions.map((item) => item.sessionId)).toEqual([sessionId]);

      const state = manager.getWindowState("@1");
      state.sessionId = sessionId;
      state.cwd = cwd;
      const resolved = await manager.resolveSessionForWindow("@1");
      expect(resolved?.sessionId).toBe(sessionId);

      const [messages, total] = await manager.getRecentMessages("@1");
      expect(total).toBe(2);
      expect(messages.map((message) => message.text)).toEqual(["hello", "hi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears stale window session when the file no longer exists", async () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      const state = manager.getWindowState("@1");
      state.sessionId = "missing";
      state.cwd = "/tmp/project";

      await expect(manager.resolveSessionForWindow("@1")).resolves.toBeNull();
      expect(manager.getWindowState("@1").sessionId).toBe("");
      expect(manager.getWindowState("@1").cwd).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager Codex session resolution", () => {
  it("lists Codex sessions for a directory", async () => {
    const dir = tmpDir();
    try {
      const manager = makeManager(dir);
      const cwd = "/tmp/project";
      const sessionId = "019e3004-fe4c-7cc1-88a5-4d253ac1cf93";
      const file = writeCodexSession(join(dir, "codex"), cwd, sessionId, [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello codex" }]
          }
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }]
          }
        }
      ]);

      const sessions = await manager.listSessionsForDirectory(cwd, "codex");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId,
        summary: "Codex summary",
        messageCount: 2,
        filePath: file,
        agentType: "codex"
      });

      const direct = await manager.getSessionDirect(sessionId, cwd, "codex");
      expect(direct?.sessionId).toBe(sessionId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager registry dual-write", () => {
  function fakeRegistry() {
    const upserts: Array<[string, string, string]> = [];
    const binds: Array<[number, number, string]> = [];
    const unbinds: Array<[number, number]> = [];
    const markedForRecovery: Array<[number, number]> = [];
    const groupChats: Array<[number, number, number]> = [];
    return {
      calls: { upserts, binds, unbinds, markedForRecovery, groupChats },
      getSessionByWindow: () => null,
      getLastEvent: () => null,
      upsertWindow: (windowId: string, displayName: string, cwd: string) => {
        upserts.push([windowId, displayName, cwd]);
      },
      bindThread: (userId: number, threadId: number, windowId: string) => {
        binds.push([userId, threadId, windowId]);
      },
      unbindThread: (userId: number, threadId: number) => {
        unbinds.push([userId, threadId]);
        return null;
      },
      markBindingForRecovery: (userId: number, threadId: number) => {
        markedForRecovery.push([userId, threadId]);
      },
      setGroupChatId: (userId: number, threadId: number, chatId: number) => {
        groupChats.push([userId, threadId, chatId]);
      }
    };
  }

  function makeManagerWithRegistry(dir: string, registry?: ReturnType<typeof fakeRegistry>): SessionManager {
    return new SessionManager({
      config: {
        stateFile: join(dir, "state.json"),
        sessionMapFile: join(dir, "session_map.json"),
        tmuxSessionName: "x",
        claudeProjectsPath: join(dir, "projects"),
        codexHomePath: join(dir, "codex"),
        agentType: "claude"
      },
      loadState: false,
      ...(registry ? { registry } : {})
    });
  }

  it("bindThread upserts window + writes binding to registry", () => {
    const dir = tmpDir();
    try {
      const registry = fakeRegistry();
      const mgr = makeManagerWithRegistry(dir, registry);
      mgr.bindThread(100, 42, "@5", "creative-project");
      expect(registry.calls.upserts).toEqual([["@5", "creative-project", ""]]);
      expect(registry.calls.binds).toEqual([[100, 42, "@5"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unbindThread mirrors to registry", () => {
    const dir = tmpDir();
    try {
      const registry = fakeRegistry();
      const mgr = makeManagerWithRegistry(dir, registry);
      mgr.bindThread(100, 42, "@5");
      mgr.unbindThread(100, 42);
      expect(registry.calls.unbinds).toEqual([[100, 42]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setGroupChatId mirrors to registry", () => {
    const dir = tmpDir();
    try {
      const registry = fakeRegistry();
      const mgr = makeManagerWithRegistry(dir, registry);
      mgr.bindThread(100, 42, "@5");
      mgr.setGroupChatId(100, 42, -100200);
      expect(registry.calls.groupChats).toEqual([[100, 42, -100200]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveSessionForWindow prefers Registry over legacy state.json", async () => {
    const dir = tmpDir();
    try {
      const registry = fakeRegistry();
      // Stub getSessionByWindow to return a registry row.
      const reg = {
        ...registry,
        getSessionByWindow: () => ({
          session_id: "reg-session",
          agent_type: "claude",
          transcript_path: "/path/to/transcript.jsonl"
        })
      };
      const mgr = makeManagerWithRegistry(dir, reg as never);
      const session = await mgr.resolveSessionForWindow("@1");
      expect(session).toEqual({
        sessionId: "reg-session",
        summary: "",
        messageCount: 0,
        filePath: "/path/to/transcript.jsonl",
        agentType: "claude"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops cleanly when registry is not provided", () => {
    const dir = tmpDir();
    try {
      const mgr = makeManagerWithRegistry(dir);
      expect(() => mgr.bindThread(100, 42, "@5")).not.toThrow();
      expect(() => mgr.unbindThread(100, 42)).not.toThrow();
      expect(() => mgr.setGroupChatId(100, 42, -1)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("markBindingForRecovery removes the in-memory binding AND forwards to registry", () => {
    // Codex review test gap: existing tests only stubbed markBindingForRecovery
    // on the registry side. This verifies the SessionManager-level dual write —
    // the in-memory threadBindings entry must be removed so live routing
    // (getWindowForThread) treats the topic as detached.
    const dir = tmpDir();
    try {
      const registry = fakeRegistry();
      const mgr = makeManagerWithRegistry(dir, registry);
      mgr.bindThread(100, 42, "@5");
      expect(mgr.getWindowForThread(100, 42)).toBe("@5");

      const returned = mgr.markBindingForRecovery(100, 42);

      expect(returned).toBe("@5");
      expect(mgr.getWindowForThread(100, 42)).toBeNull();
      expect(registry.calls.markedForRecovery).toEqual([[100, 42]]);
      // Hard-delete path is untouched — markBindingForRecovery must NOT call
      // unbindThread (the binding row must survive in the registry).
      expect(registry.calls.unbinds).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrateFromRegistry tolerates a registry whose iterThreadBindings filters out NULL window_id rows", () => {
    // Codex review HIGH: previously the registry returned NULL window_id for
    // recovery_pending rows, hydrateFromRegistry wrote them into the in-memory
    // map, and resolveStaleIds crashed calling .startsWith on null. The fix is
    // on the registry side (iterThreadBindings WHERE window_id IS NOT NULL).
    // This test pins that contract: SessionManager.hydrateFromRegistry must
    // not crash if the registry only emits real window IDs.
    const dir = tmpDir();
    try {
      const mgr = makeManagerWithRegistry(dir);
      const registry = {
        listLiveWindows: () => [{ window_id: "@5", display_name: "alive", cwd: "/work" }],
        // Real registry filters NULL window_id; nothing yielded here.
        iterThreadBindings: function* (): IterableIterator<[number, number, string]> {},
        resolveChatId: (userId: number) => userId,
        getTopicProbeMessageId: () => null,
        getUserWindowOffset: () => null
      };
      expect(() => mgr.hydrateFromRegistry(registry)).not.toThrow();
      expect(mgr.getWindowForThread(100, 42)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
