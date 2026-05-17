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
    expect(rows[0].display_name).toBe("renamed");
    expect(rows[0].cwd).toBe("/b");
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
