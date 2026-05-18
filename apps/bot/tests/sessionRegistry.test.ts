import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";

describe("SessionRegistry schema", () => {
  test("creates all required tables on first open", () => {
    const db = inMemoryDb();
    new SessionRegistry(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("meta");
    expect(names).toContain("windows");
    expect(names).toContain("sessions");
    expect(names).toContain("thread_bindings");
    expect(names).toContain("user_window_offsets");
  });

  test("writes schema_version=1 into meta", () => {
    const db = inMemoryDb();
    new SessionRegistry(db);
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("1");
  });
});

describe("SessionRegistry windows", () => {
  test("upsertWindow inserts a row", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "myproject", "/work/myproject");
    expect(reg.listLiveWindows()).toEqual([
      {
        window_id: "@0",
        display_name: "myproject",
        cwd: "/work/myproject",
        created_at: expect.any(Number)
      }
    ]);
  });

  test("upsertWindow updates display name on conflict", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "first", "/a");
    reg.upsertWindow("@0", "renamed", "/b");
    const rows = reg.listLiveWindows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.display_name).toBe("renamed");
    expect(rows[0]?.cwd).toBe("/b");
  });

  test("deleteWindow removes row", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.deleteWindow("@0");
    expect(reg.listLiveWindows()).toEqual([]);
  });
});

describe("SessionRegistry sessions", () => {
  test("registerSession inserts row", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.registerSession({
      sessionId: "S1",
      windowId: "@0",
      agentType: "claude",
      transcriptPath: "/tmp/s1.jsonl",
      cwd: "/a",
      source: "startup"
    });
    expect(reg.getSession("S1")).toMatchObject({
      session_id: "S1",
      window_id: "@0",
      agent_type: "claude",
      transcript_path: "/tmp/s1.jsonl",
      cwd: "/a",
      source: "startup",
      last_byte_offset: 0
    });
  });

  test("registerSession replaces existing session for same window", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p1", cwd: "/a" });
    reg.registerSession({ sessionId: "S2", windowId: "@0", agentType: "claude", transcriptPath: "/p2", cwd: "/a" });
    expect(reg.getSession("S1")).toBeNull();
    expect(reg.getSession("S2")).not.toBeNull();
    expect(reg.getSessionByWindow("@0")?.session_id).toBe("S2");
  });

  test("endSession deletes the row", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p", cwd: "/a" });
    reg.endSession("S1");
    expect(reg.getSession("S1")).toBeNull();
  });

  test("deleteWindow cascades to sessions", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p", cwd: "/a" });
    reg.deleteWindow("@0");
    expect(reg.getSession("S1")).toBeNull();
  });

  test("allLiveSessions returns all sessions", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "a", "/a");
    reg.upsertWindow("@1", "b", "/b");
    reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p1", cwd: "/a" });
    reg.registerSession({ sessionId: "S2", windowId: "@1", agentType: "codex", transcriptPath: "/p2", cwd: "/b" });
    expect(reg.allLiveSessions().map((s) => s.session_id).sort()).toEqual(["S1", "S2"]);
  });

  test("setOffset updates last_byte_offset", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p", cwd: "/a" });
    reg.setOffset("S1", 4096);
    expect(reg.getSession("S1")?.last_byte_offset).toBe(4096);
  });
});

describe("SessionRegistry bindings", () => {
  test("bindThread + resolveWindowForThread round trip", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.bindThread(123, 42, "@0");
    expect(reg.resolveWindowForThread(123, 42)).toBe("@0");
  });

  test("unbindThread removes binding", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.bindThread(123, 42, "@0");
    expect(reg.unbindThread(123, 42)).toBe("@0");
    expect(reg.resolveWindowForThread(123, 42)).toBeNull();
  });

  test("iterThreadBindings enumerates all", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.upsertWindow("@1", "y", "/b");
    reg.bindThread(1, 10, "@0");
    reg.bindThread(2, 20, "@1");
    const got = [...reg.iterThreadBindings()].sort();
    expect(got).toEqual([
      [1, 10, "@0"],
      [2, 20, "@1"]
    ]);
  });

  test("setGroupChatId + resolveChatId", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.bindThread(123, 42, "@0");
    reg.setGroupChatId(123, 42, -100200300);
    expect(reg.resolveChatId(123, 42)).toBe(-100200300);
  });

  test("resolveChatId falls back to userId when no group binding", () => {
    const reg = new SessionRegistry(inMemoryDb());
    expect(reg.resolveChatId(123, 42)).toBe(123);
    expect(reg.resolveChatId(123, null)).toBe(123);
  });

  test("topic probe message id round trip", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.bindThread(123, 42, "@0");
    reg.setTopicProbeMessageId(123, 42, 9001);
    expect(reg.getTopicProbeMessageId(123, 42)).toBe(9001);
  });

  test("deleteWindow cascades to thread_bindings", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.bindThread(1, 10, "@0");
    reg.deleteWindow("@0");
    expect(reg.resolveWindowForThread(1, 10)).toBeNull();
  });
});

describe("SessionRegistry lastEvent", () => {
  test("recordEvent + getLastEvent round trip", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.recordEvent("@0", "Stop", 1000);
    expect(reg.getLastEvent("@0")).toEqual({ event: "Stop", at: 1000 });
    reg.recordEvent("@0", "PostToolUse", 2000);
    expect(reg.getLastEvent("@0")).toEqual({ event: "PostToolUse", at: 2000 });
  });

  test("getLastEvent returns null when unset", () => {
    const reg = new SessionRegistry(inMemoryDb());
    expect(reg.getLastEvent("@0")).toBeNull();
  });

  test("deleteWindow clears lastEvent for that window", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.upsertWindow("@1", "y", "/b");
    reg.recordEvent("@0", "Stop");
    reg.recordEvent("@1", "Stop");
    reg.deleteWindow("@0");
    expect(reg.getLastEvent("@0")).toBeNull();
    expect(reg.getLastEvent("@1")).not.toBeNull();
  });
});

describe("SessionRegistry user_window_offsets", () => {
  test("updateUserWindowOffset round trip", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.updateUserWindowOffset(123, "@0", 4096);
    expect(reg.getUserWindowOffset(123, "@0")).toBe(4096);
    reg.updateUserWindowOffset(123, "@0", 8192);
    expect(reg.getUserWindowOffset(123, "@0")).toBe(8192);
  });

  test("getUserWindowOffset returns null when absent", () => {
    const reg = new SessionRegistry(inMemoryDb());
    expect(reg.getUserWindowOffset(123, "@0")).toBeNull();
  });

  test("deleteWindow cascades to user_window_offsets", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/a");
    reg.updateUserWindowOffset(123, "@0", 4096);
    reg.deleteWindow("@0");
    expect(reg.getUserWindowOffset(123, "@0")).toBeNull();
  });
});
