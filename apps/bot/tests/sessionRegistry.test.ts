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

describe("SessionRegistry recovery anchor (last_session_id)", () => {
  // The bot was wiped by Plan A's predecessor on an unrelated tmux outage —
  // these tests lock in the soft anchor that lets us reconnect after tmux
  // restarts without losing the user's session pointer.

  function registerStartCase(reg: SessionRegistry, sessionId: string, windowId = "@0") {
    reg.registerSession({
      sessionId,
      windowId,
      agentType: "claude",
      transcriptPath: `/tmp/${sessionId}.jsonl`,
      cwd: "/work"
    });
  }

  test("registerSession populates last_session_id on the bound thread", () => {
    const db = inMemoryDb();
    const reg = new SessionRegistry(db);
    reg.upsertWindow("@0", "x", "/work");
    reg.bindThread(111, 42, "@0");
    registerStartCase(reg, "sess-alpha");

    const row = db
      .prepare(
        "SELECT last_session_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?"
      )
      .get(111, 42) as { last_session_id: string | null };
    expect(row.last_session_id).toBe("sess-alpha");
  });

  test("subsequent registerSession (e.g. /clear, /compact, --resume) overwrites the anchor", () => {
    const db = inMemoryDb();
    const reg = new SessionRegistry(db);
    reg.upsertWindow("@0", "x", "/work");
    reg.bindThread(111, 42, "@0");

    registerStartCase(reg, "sess-alpha");
    registerStartCase(reg, "sess-beta"); // simulate /clear rotating the id
    registerStartCase(reg, "sess-gamma"); // and a manual --resume after that

    const row = db
      .prepare(
        "SELECT last_session_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?"
      )
      .get(111, 42) as { last_session_id: string };
    expect(row.last_session_id).toBe("sess-gamma");
  });

  test("listRecoverableBindings only surfaces bindings that are recovery_pending AND have an anchor", () => {
    // (codex review: previously this filter was `last_session_id IS NOT NULL`,
    // which would surface healthy bindings too and risk misleading "resume"
    // prompts. Now the filter requires recovery_pending = 1 — i.e. the
    // binding has been soft-cleaned by statusPolling.)
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/work");
    reg.upsertWindow("@1", "y", "/work2");
    reg.bindThread(111, 42, "@0");
    reg.bindThread(111, 43, "@1");
    registerStartCase(reg, "sess-alpha", "@0");
    registerStartCase(reg, "sess-beta", "@1");

    // Both have anchors but neither has been marked for recovery yet.
    expect(reg.listRecoverableBindings()).toEqual([]);

    // Mark only the first one — only it should appear.
    reg.markBindingForRecovery(111, 42);
    expect(reg.listRecoverableBindings()).toEqual([
      { userId: 111, threadId: 42, windowId: null, lastSessionId: "sess-alpha" }
    ]);
  });

  test("migration adds last_session_id to a pre-existing DB without the column", () => {
    // Simulate an upgrade from a DB that predates this column. The schema
    // CREATE TABLE IF NOT EXISTS won't backfill columns, so the migration
    // path is what we're exercising here.
    const db = inMemoryDb();
    db.exec(`
      CREATE TABLE thread_bindings (
        user_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        window_id TEXT NOT NULL,
        group_chat_id INTEGER,
        topic_probe_message_id INTEGER,
        bound_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, thread_id)
      );
    `);

    // Constructing the registry should ALTER TABLE to add the column.
    new SessionRegistry(db);

    const cols = db
      .prepare("PRAGMA table_info(thread_bindings)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("last_session_id");
  });
});

describe("SessionRegistry soft-delete recovery", () => {
  function registerStart(reg: SessionRegistry, sessionId: string, windowId = "@0") {
    reg.registerSession({
      sessionId,
      windowId,
      agentType: "claude",
      transcriptPath: `/tmp/${sessionId}.jsonl`,
      cwd: "/work"
    });
  }

  function setup(): { reg: SessionRegistry; db: ReturnType<typeof inMemoryDb> } {
    const db = inMemoryDb();
    const reg = new SessionRegistry(db);
    reg.upsertWindow("@0", "x", "/work");
    reg.bindThread(111, 42, "@0");
    registerStart(reg, "sess-1");
    return { reg, db };
  }

  test("markBindingForRecovery preserves binding row + last_session_id, clears window_id, sets pending flag", () => {
    const { reg, db } = setup();
    reg.markBindingForRecovery(111, 42);

    const row = db
      .prepare(
        "SELECT window_id, last_session_id, recovery_pending FROM thread_bindings WHERE user_id = ? AND thread_id = ?"
      )
      .get(111, 42) as { window_id: string | null; last_session_id: string; recovery_pending: number };
    expect(row.window_id).toBeNull();
    expect(row.last_session_id).toBe("sess-1");
    expect(row.recovery_pending).toBe(1);
  });

  test("deleteWindow after markBindingForRecovery still preserves the binding row (FK SET NULL, not CASCADE)", () => {
    // The whole point of the schema migration: when the windows row is
    // deleted on a soft cleanup, the binding row must survive so the resume
    // picker can find the anchor.
    const { reg, db } = setup();
    reg.markBindingForRecovery(111, 42);
    reg.deleteWindow("@0");

    const row = db
      .prepare(
        "SELECT user_id, last_session_id, recovery_pending FROM thread_bindings WHERE user_id = ? AND thread_id = ?"
      )
      .get(111, 42) as { user_id: number; last_session_id: string; recovery_pending: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.last_session_id).toBe("sess-1");
    expect(row!.recovery_pending).toBe(1);
  });

  test("getRecoveryAnchor returns anchor only while pending; null after a fresh bindThread", () => {
    const { reg } = setup();
    expect(reg.getRecoveryAnchor(111, 42)).toBeNull(); // no outage yet

    reg.markBindingForRecovery(111, 42);
    expect(reg.getRecoveryAnchor(111, 42)).toBe("sess-1");

    // User re-/joins to a new window — bindThread ON CONFLICT clears
    // recovery_pending, so the anchor is no longer "needed" and getRecoveryAnchor
    // suppresses it. last_session_id itself is still there (will be overwritten
    // by the next SessionStart for the new window).
    reg.upsertWindow("@1", "x", "/work");
    reg.bindThread(111, 42, "@1");
    expect(reg.getRecoveryAnchor(111, 42)).toBeNull();
  });

  test("iterThreadBindings skips rows whose window_id is NULL (soft-deleted)", () => {
    // Codex review: hydrateFromRegistry / resolveStaleIds assume window_id is
    // a real tmux ID and crash on NULL. iterThreadBindings must filter out
    // recovery_pending rows so downstream consumers only ever see live
    // bindings — anchors are surfaced separately via listRecoverableBindings.
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "x", "/work");
    reg.upsertWindow("@1", "y", "/work2");
    reg.bindThread(111, 42, "@0");
    reg.bindThread(111, 43, "@1");
    registerStart(reg, "sess-1", "@0");
    registerStart(reg, "sess-2", "@1");

    reg.markBindingForRecovery(111, 42); // @0 → window_id NULL

    const rows = [...reg.iterThreadBindings()];
    expect(rows).toEqual([[111, 43, "@1"]]);
  });

  test("schema-recreate migration adds recovery_pending + window_id NULL to a pre-existing v2 DB", () => {
    // v2 had last_session_id but NOT_NULL window_id and CASCADE FK. The
    // schema-recreate migration must add recovery_pending and flip the FK.
    const db = inMemoryDb();
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE windows (
        window_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE thread_bindings (
        user_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        window_id TEXT NOT NULL,
        group_chat_id INTEGER,
        topic_probe_message_id INTEGER,
        bound_at INTEGER NOT NULL,
        last_session_id TEXT,
        PRIMARY KEY (user_id, thread_id),
        FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
      );
      INSERT INTO windows VALUES('@0', 'x', '/work', 1);
      INSERT INTO thread_bindings VALUES(111, 42, '@0', NULL, NULL, 1, 'sess-legacy');
    `);

    new SessionRegistry(db); // runs migration

    const cols = db
      .prepare("PRAGMA table_info(thread_bindings)")
      .all() as Array<{ name: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.recovery_pending).toBeDefined();
    expect(byName.window_id?.notnull).toBe(0); // was 1, now nullable

    // Existing data preserved.
    const row = db
      .prepare("SELECT last_session_id, recovery_pending FROM thread_bindings WHERE user_id = 111")
      .get() as { last_session_id: string; recovery_pending: number };
    expect(row.last_session_id).toBe("sess-legacy");
    expect(row.recovery_pending).toBe(0);

    // FK is now ON DELETE SET NULL: deleting the window leaves the binding row.
    db.prepare("DELETE FROM windows WHERE window_id = ?").run("@0");
    const afterFk = db
      .prepare("SELECT window_id, last_session_id FROM thread_bindings WHERE user_id = 111")
      .get() as { window_id: string | null; last_session_id: string };
    expect(afterFk.window_id).toBeNull();
    expect(afterFk.last_session_id).toBe("sess-legacy");
  });
});
