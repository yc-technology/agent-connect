# Hook-Driven Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace polling-based `SessionMonitor` + multi-JSON-file state with hook-event-driven runtime backed by per-bot SQLite. Eliminates the first-response race and resume-session-id mismatch documented in `docs/superpowers/specs/2026-05-17-hook-driven-runtime-design.md`.

**Architecture:** Claude/Codex hooks POST events to bot's Fastify `/hook/events`. A per-bot `HookRouter` serializes events per window, calls `drainTranscript` (which reads jsonl from `last_byte_offset` to EOF inside a per-session lock) and dispatches via existing `MessageQueueManager`. Per-bot SQLite (`bot.sqlite`) replaces `session_map.json` + `state.json` + `monitor_state.json`.

**Tech Stack:** TypeScript, Node.js 22, Fastify 5, grammY, `better-sqlite3` 12, Vitest, tmux, pnpm.

---

## Prerequisites

- Working tree must be clean for predictable diffs. The repo currently has ~18 WIP files in working tree. Before starting, EITHER:
  - **a)** `git stash push -u -m "wip-before-hook-refactor"` and pop later after PR-3 is merged, OR
  - **b)** Branch from `main` (commit `faac072`) with `git switch -c hook-refactor faac072`, do the work there, then rebase the WIP on top.
- Choose (b) by default. Each PR below produces one commit on `hook-refactor`.
- Required reading before starting: `docs/superpowers/specs/2026-05-17-hook-driven-runtime-design.md`.
- Run `pnpm install` once after branch creation to ensure `node_modules` is consistent.

---

## File Inventory (Reference)

What this plan creates / modifies / deletes. Cross-check during implementation.

**Create:**

```
apps/bot/src/agent-connect/sessionRegistry.ts
apps/bot/src/agent-connect/sessionLookup.ts
apps/bot/src/agent-connect/hookTypes.ts
apps/bot/src/agent-connect/hookInstaller.ts
apps/bot/src/agent-connect/hookClient.ts
apps/bot/src/agent-connect/hookRouter.ts
apps/bot/src/agent-connect/drainTranscript.ts
apps/bot/src/agent-connect/migration.ts
apps/bot/src/agent-connect/runtimeJson.ts
apps/bot/tests/helpers/registryFixtures.ts
apps/bot/tests/helpers/transcriptFixtures.ts
apps/bot/tests/helpers/hookEnvelope.ts
apps/bot/tests/sessionRegistry.test.ts
apps/bot/tests/sessionRegistry-lock.test.ts
apps/bot/tests/drainTranscript.test.ts
apps/bot/tests/hookRouter.test.ts
apps/bot/tests/hookServer.test.ts
apps/bot/tests/migration.test.ts
apps/bot/tests/runtimeJson.test.ts
apps/bot/tests/regression-first-response-race.test.ts
apps/bot/tests/regression-resume-session-mismatch.test.ts
```

**Modify:**

```
apps/bot/src/agent-connect/multiBotRuntime.ts
apps/bot/src/agent-connect/server.ts
apps/bot/src/agent-connect/service.ts
apps/bot/src/agent-connect/statusPolling.ts
apps/bot/src/agent-connect/bot.ts
apps/bot/src/agent-connect/runtime.ts
apps/bot/src/agent-connect/codexSessions.ts
apps/bot/src/agent-connect/history.ts
apps/bot/tests/statusPolling.test.ts
apps/bot/tests/server.test.ts
apps/bot/tests/bot.test.ts
CLAUDE.md
.claude/rules/architecture.md
.claude/rules/topic-architecture.md
.claude/rules/message-handling.md
```

**Delete:**

```
apps/bot/src/agent-connect/sessionMonitor.ts
apps/bot/src/agent-connect/monitorState.ts
apps/bot/src/agent-connect/session.ts          (after migration of callers)
apps/bot/src/agent-connect/hook.ts             (after split)
apps/bot/tests/sessionMonitor.test.ts          (if present)
apps/bot/tests/session.test.ts                 (after rewrite)
apps/bot/tests/hook.test.ts                    (if present, after split)
```

---

# PR-1: Infrastructure (Registry + Migration + RuntimeJson)

Pure additions. Compiles and tests independently. No call sites change yet. Old monitor still runs.

---

### Task 1.1: Add test fixture helpers

**Files:**
- Create: `apps/bot/tests/helpers/registryFixtures.ts`
- Create: `apps/bot/tests/helpers/transcriptFixtures.ts`
- Create: `apps/bot/tests/helpers/hookEnvelope.ts`

- [ ] **Step 1: Create `registryFixtures.ts`**

```ts
// apps/bot/tests/helpers/registryFixtures.ts
import Database from "better-sqlite3";

export function inMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}
```

- [ ] **Step 2: Create `transcriptFixtures.ts`**

```ts
// apps/bot/tests/helpers/transcriptFixtures.ts
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TranscriptEntry {
  type: "user" | "assistant" | string;
  [key: string]: unknown;
}

let tmpRoot: string | null = null;
async function ensureTmpRoot(): Promise<string> {
  if (!tmpRoot) tmpRoot = await mkdtemp(join(tmpdir(), "agc-test-"));
  return tmpRoot;
}

export async function writeFakeTranscript(
  entries: TranscriptEntry[],
  opts: { sessionId?: string } = {}
): Promise<string> {
  const root = await ensureTmpRoot();
  const name = `${opts.sessionId ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`}.jsonl`;
  const path = join(root, name);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  await writeFile(path, content, "utf8");
  return path;
}

export async function appendToTranscript(
  path: string,
  entries: TranscriptEntry[]
): Promise<void> {
  if (!entries.length) return;
  await appendFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
```

- [ ] **Step 3: Create `hookEnvelope.ts`**

```ts
// apps/bot/tests/helpers/hookEnvelope.ts
import type { HookEnvelope, HookEventName } from "../../src/agent-connect/hookTypes.js";

export function envelope(
  eventName: HookEventName,
  payload: Record<string, unknown> = {},
  overrides: Partial<HookEnvelope> = {}
): HookEnvelope {
  return {
    tmux_session: overrides.tmux_session ?? "test-session",
    window_id: overrides.window_id ?? "@0",
    window_name: overrides.window_name ?? "test",
    payload: {
      session_id: "X",
      transcript_path: "/tmp/test.jsonl",
      cwd: "/tmp",
      hook_event_name: eventName,
      ...payload,
    },
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/bot/tests/helpers/
git commit -m "test: add helpers for in-memory sqlite, transcript fixtures, hook envelopes"
```

---

### Task 1.2: hookTypes.ts (shared envelope/payload types)

**Files:**
- Create: `apps/bot/src/agent-connect/hookTypes.ts`

- [ ] **Step 1: Write the file**

```ts
// apps/bot/src/agent-connect/hookTypes.ts
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolBatch"
  | "PostToolUseFailure"
  | "Stop"
  | "Notification"
  | "PermissionRequest";

export interface HookCommonFields {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: HookEventName;
  permission_mode?: string;
  model?: string;
}

export interface HookEnvelope {
  tmux_session: string;
  window_id: string;
  window_name: string;
  payload: HookCommonFields & Record<string, unknown>;
}

export type AgentType = "claude" | "codex";
```

- [ ] **Step 2: Verify it typechecks standalone**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/bot/src/agent-connect/hookTypes.ts
git commit -m "feat(hook): add shared envelope/payload types"
```

---

### Task 1.3: SessionRegistry skeleton + schema

**Files:**
- Create: `apps/bot/src/agent-connect/sessionRegistry.ts`
- Test: `apps/bot/tests/sessionRegistry.test.ts`

- [ ] **Step 1: Write failing test for schema bootstrap**

```ts
// apps/bot/tests/sessionRegistry.test.ts
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
```

- [ ] **Step 2: Run test (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: FAIL — `SessionRegistry` not found.

- [ ] **Step 3: Implement skeleton with schema**

```ts
// apps/bot/src/agent-connect/sessionRegistry.ts
import type Database from "better-sqlite3";

const SCHEMA_VERSION = "1";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS windows (
  window_id    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  window_id        TEXT NOT NULL,
  agent_type       TEXT NOT NULL,
  transcript_path  TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  source           TEXT,
  last_byte_offset INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_window ON sessions(window_id);

CREATE TABLE IF NOT EXISTS thread_bindings (
  user_id                INTEGER NOT NULL,
  thread_id              INTEGER NOT NULL,
  window_id              TEXT NOT NULL,
  group_chat_id          INTEGER,
  topic_probe_message_id INTEGER,
  bound_at               INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bindings_window ON thread_bindings(window_id);

CREATE TABLE IF NOT EXISTS user_window_offsets (
  user_id     INTEGER NOT NULL,
  window_id   TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
`;

export class SessionRegistry {
  constructor(private readonly db: Database.Database) {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    const existing = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("schema_version") as { value: string } | undefined;
    if (!existing) {
      db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
        "schema_version",
        SCHEMA_VERSION
      );
    }
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/sessionRegistry.ts apps/bot/tests/sessionRegistry.test.ts
git commit -m "feat(registry): add SessionRegistry with schema bootstrap"
```

---

### Task 1.4: SessionRegistry — windows CRUD

**Files:**
- Modify: `apps/bot/src/agent-connect/sessionRegistry.ts`
- Modify: `apps/bot/tests/sessionRegistry.test.ts`

- [ ] **Step 1: Add failing tests for windows CRUD**

Append to `sessionRegistry.test.ts`:

```ts
describe("SessionRegistry windows", () => {
  test("upsertWindow inserts a row", () => {
    const reg = new SessionRegistry(inMemoryDb());
    reg.upsertWindow("@0", "myproject", "/work/myproject");
    expect(reg.listLiveWindows()).toEqual([
      { window_id: "@0", display_name: "myproject", cwd: "/work/myproject", created_at: expect.any(Number) },
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
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add export types + methods to `sessionRegistry.ts`**

Add at top of file:

```ts
export interface WindowRow {
  window_id: string;
  display_name: string;
  cwd: string;
  created_at: number;
}
```

Add inside class:

```ts
upsertWindow(windowId: string, displayName: string, cwd: string): void {
  this.db
    .prepare(
      `INSERT INTO windows (window_id, display_name, cwd, created_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(window_id) DO UPDATE SET
         display_name = excluded.display_name,
         cwd = excluded.cwd`
    )
    .run(windowId, displayName, cwd, Date.now());
}

deleteWindow(windowId: string): void {
  this.db.prepare("DELETE FROM windows WHERE window_id = ?").run(windowId);
}

listLiveWindows(): WindowRow[] {
  return this.db
    .prepare("SELECT window_id, display_name, cwd, created_at FROM windows ORDER BY window_id")
    .all() as WindowRow[];
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/sessionRegistry.ts apps/bot/tests/sessionRegistry.test.ts
git commit -m "feat(registry): add windows CRUD"
```

---

### Task 1.5: SessionRegistry — sessions CRUD (DELETE+INSERT semantics)

**Files:**
- Modify: `apps/bot/src/agent-connect/sessionRegistry.ts`
- Modify: `apps/bot/tests/sessionRegistry.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
      source: "startup",
    });
    expect(reg.getSession("S1")).toMatchObject({
      session_id: "S1",
      window_id: "@0",
      agent_type: "claude",
      transcript_path: "/tmp/s1.jsonl",
      cwd: "/a",
      source: "startup",
      last_byte_offset: 0,
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
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: FAIL.

- [ ] **Step 3: Add types + methods**

In `sessionRegistry.ts` add to top:

```ts
import type { AgentType } from "./hookTypes.js";

export interface SessionRow {
  session_id: string;
  window_id: string;
  agent_type: AgentType;
  transcript_path: string;
  cwd: string;
  source: string | null;
  last_byte_offset: number;
  started_at: number;
}

export interface RegisterSessionArgs {
  sessionId: string;
  windowId: string;
  agentType: AgentType;
  transcriptPath: string;
  cwd: string;
  source?: string;
  startedAt?: number;
  lastByteOffset?: number;
}
```

In class:

```ts
registerSession(args: RegisterSessionArgs): void {
  const startedAt = args.startedAt ?? Date.now();
  const lastByteOffset = args.lastByteOffset ?? 0;
  const tx = this.db.transaction((a: RegisterSessionArgs) => {
    this.db.prepare("DELETE FROM sessions WHERE window_id = ?").run(a.windowId);
    this.db
      .prepare(
        `INSERT INTO sessions
           (session_id, window_id, agent_type, transcript_path, cwd, source, last_byte_offset, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.sessionId,
        a.windowId,
        a.agentType,
        a.transcriptPath,
        a.cwd,
        a.source ?? null,
        lastByteOffset,
        startedAt
      );
  });
  tx(args);
}

endSession(sessionId: string): void {
  this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
}

getSession(sessionId: string): SessionRow | null {
  const row = this.db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

getSessionByWindow(windowId: string): SessionRow | null {
  const row = this.db
    .prepare("SELECT * FROM sessions WHERE window_id = ?")
    .get(windowId) as SessionRow | undefined;
  return row ?? null;
}

allLiveSessions(): SessionRow[] {
  return this.db.prepare("SELECT * FROM sessions").all() as SessionRow[];
}

setOffset(sessionId: string, offset: number): void {
  this.db
    .prepare("UPDATE sessions SET last_byte_offset = ? WHERE session_id = ?")
    .run(offset, sessionId);
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/sessionRegistry.ts apps/bot/tests/sessionRegistry.test.ts
git commit -m "feat(registry): add sessions CRUD with DELETE+INSERT and FK cascade"
```

---

### Task 1.6: SessionRegistry — thread_bindings + group_chat + topic_probe

**Files:**
- Modify: `apps/bot/src/agent-connect/sessionRegistry.ts`
- Modify: `apps/bot/tests/sessionRegistry.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
      [2, 20, "@1"],
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
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: FAIL.

- [ ] **Step 3: Add methods**

In class:

```ts
bindThread(userId: number, threadId: number, windowId: string): void {
  this.db
    .prepare(
      `INSERT INTO thread_bindings (user_id, thread_id, window_id, bound_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, thread_id) DO UPDATE SET
         window_id = excluded.window_id,
         bound_at = excluded.bound_at`
    )
    .run(userId, threadId, windowId, Date.now());
}

unbindThread(userId: number, threadId: number): string | null {
  const row = this.db
    .prepare("SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
    .get(userId, threadId) as { window_id: string } | undefined;
  if (!row) return null;
  this.db
    .prepare("DELETE FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
    .run(userId, threadId);
  return row.window_id;
}

resolveWindowForThread(userId: number, threadId: number): string | null {
  const row = this.db
    .prepare("SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
    .get(userId, threadId) as { window_id: string } | undefined;
  return row?.window_id ?? null;
}

*iterThreadBindings(): IterableIterator<[number, number, string]> {
  const rows = this.db
    .prepare("SELECT user_id, thread_id, window_id FROM thread_bindings ORDER BY user_id, thread_id")
    .all() as Array<{ user_id: number; thread_id: number; window_id: string }>;
  for (const r of rows) yield [r.user_id, r.thread_id, r.window_id];
}

setGroupChatId(userId: number, threadId: number, chatId: number): void {
  this.db
    .prepare(
      `UPDATE thread_bindings SET group_chat_id = ?
         WHERE user_id = ? AND thread_id = ?`
    )
    .run(chatId, userId, threadId);
}

resolveChatId(userId: number, threadId: number | null): number {
  if (threadId === null) return userId;
  const row = this.db
    .prepare(
      "SELECT group_chat_id FROM thread_bindings WHERE user_id = ? AND thread_id = ? AND group_chat_id IS NOT NULL"
    )
    .get(userId, threadId) as { group_chat_id: number } | undefined;
  return row?.group_chat_id ?? userId;
}

setTopicProbeMessageId(userId: number, threadId: number, messageId: number): void {
  this.db
    .prepare(
      `UPDATE thread_bindings SET topic_probe_message_id = ?
         WHERE user_id = ? AND thread_id = ?`
    )
    .run(messageId, userId, threadId);
}

getTopicProbeMessageId(userId: number, threadId: number): number | null {
  const row = this.db
    .prepare(
      "SELECT topic_probe_message_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?"
    )
    .get(userId, threadId) as { topic_probe_message_id: number | null } | undefined;
  return row?.topic_probe_message_id ?? null;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/sessionRegistry.ts apps/bot/tests/sessionRegistry.test.ts
git commit -m "feat(registry): add thread bindings + group chat + topic probe storage"
```

---

### Task 1.7: SessionRegistry — user_window_offsets

**Files:**
- Modify: `apps/bot/src/agent-connect/sessionRegistry.ts`
- Modify: `apps/bot/tests/sessionRegistry.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: FAIL.

- [ ] **Step 3: Add methods**

In class:

```ts
updateUserWindowOffset(userId: number, windowId: string, offset: number): void {
  this.db
    .prepare(
      `INSERT INTO user_window_offsets (user_id, window_id, byte_offset)
         VALUES (?, ?, ?)
       ON CONFLICT(user_id, window_id) DO UPDATE SET
         byte_offset = excluded.byte_offset`
    )
    .run(userId, windowId, offset);
}

getUserWindowOffset(userId: number, windowId: string): number | null {
  const row = this.db
    .prepare("SELECT byte_offset FROM user_window_offsets WHERE user_id = ? AND window_id = ?")
    .get(userId, windowId) as { byte_offset: number } | undefined;
  return row?.byte_offset ?? null;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/sessionRegistry.ts apps/bot/tests/sessionRegistry.test.ts
git commit -m "feat(registry): add user_window_offsets storage"
```

---

### Task 1.8: SessionRegistry — per-session lock (`withSessionLock`)

**Files:**
- Modify: `apps/bot/src/agent-connect/sessionRegistry.ts`
- Create: `apps/bot/tests/sessionRegistry-lock.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/bot/tests/sessionRegistry-lock.test.ts
import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup() {
  const reg = new SessionRegistry(inMemoryDb());
  reg.upsertWindow("@0", "x", "/a");
  reg.upsertWindow("@1", "y", "/b");
  reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p1", cwd: "/a" });
  reg.registerSession({ sessionId: "S2", windowId: "@1", agentType: "claude", transcriptPath: "/p2", cwd: "/b" });
  return reg;
}

describe("SessionRegistry withSessionLock", () => {
  test("serializes same-session callers (no overlap)", async () => {
    const reg = setup();
    const events: string[] = [];
    const ops = [
      reg.withSessionLock("S1", async () => {
        events.push("A-in");
        await sleep(40);
        events.push("A-out");
      }),
      reg.withSessionLock("S1", async () => {
        events.push("B-in");
        await sleep(10);
        events.push("B-out");
      }),
    ];
    await Promise.all(ops);
    expect(events).toEqual(["A-in", "A-out", "B-in", "B-out"]);
  });

  test("different sessions run in parallel", async () => {
    const reg = setup();
    const start = Date.now();
    await Promise.all([
      reg.withSessionLock("S1", async () => sleep(50)),
      reg.withSessionLock("S2", async () => sleep(50)),
    ]);
    expect(Date.now() - start).toBeLessThan(90);
  });

  test("lock released when callback throws", async () => {
    const reg = setup();
    await expect(
      reg.withSessionLock("S1", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const ok = await reg.withSessionLock("S1", async () => "still works");
    expect(ok).toBe("still works");
  });

  test("callback receives current SessionRow", async () => {
    const reg = setup();
    const seen = await reg.withSessionLock("S1", async (s) => s.transcript_path);
    expect(seen).toBe("/p1");
  });

  test("unknown session id throws without leaking lock", async () => {
    const reg = setup();
    await expect(reg.withSessionLock("UNKNOWN", async () => 1)).rejects.toThrow();
    // subsequent call on a known session should still work
    const ok = await reg.withSessionLock("S1", async () => "ok");
    expect(ok).toBe("ok");
  });

  test("setOffset inside lock is visible to next caller", async () => {
    const reg = setup();
    await reg.withSessionLock("S1", async () => {
      reg.setOffset("S1", 1234);
    });
    const next = await reg.withSessionLock("S1", async (s) => s.last_byte_offset);
    expect(next).toBe(1234);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry-lock`
Expected: FAIL — `withSessionLock` not found.

- [ ] **Step 3: Implement lock**

In `sessionRegistry.ts` add private field and method:

```ts
private readonly locks = new Map<string, Promise<unknown>>();

async withSessionLock<T>(
  sessionId: string,
  fn: (session: SessionRow) => Promise<T>
): Promise<T> {
  const prev = this.locks.get(sessionId) ?? Promise.resolve();
  let resolveNext: () => void;
  const gate = new Promise<void>((r) => { resolveNext = r; });
  // Replace the slot synchronously so following calls queue behind us.
  this.locks.set(sessionId, gate);
  try {
    await prev;
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`withSessionLock: session ${sessionId} not found`);
    }
    return await fn(session);
  } finally {
    resolveNext!();
    if (this.locks.get(sessionId) === gate) this.locks.delete(sessionId);
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionRegistry-lock`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/sessionRegistry.ts apps/bot/tests/sessionRegistry-lock.test.ts
git commit -m "feat(registry): add per-session in-memory mutex"
```

---

### Task 1.9: runtimeJson helper

**Files:**
- Create: `apps/bot/src/agent-connect/runtimeJson.ts`
- Create: `apps/bot/tests/runtimeJson.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/bot/tests/runtimeJson.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  writeRuntimeJson,
  readRuntimeJson,
  removeRuntimeJson,
  tcpProbe,
} from "../src/agent-connect/runtimeJson.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runtime-json-test-"));
});

describe("runtimeJson", () => {
  test("write then read", async () => {
    await writeRuntimeJson(dir, { httpHost: "127.0.0.1", httpPort: 8787, pid: 99 });
    const got = await readRuntimeJson(dir);
    expect(got).toEqual({ httpHost: "127.0.0.1", httpPort: 8787, pid: 99 });
  });

  test("read returns null when absent", async () => {
    expect(await readRuntimeJson(dir)).toBeNull();
  });

  test("remove is idempotent", async () => {
    await removeRuntimeJson(dir);
    await writeRuntimeJson(dir, { httpHost: "127.0.0.1", httpPort: 1, pid: 1 });
    await removeRuntimeJson(dir);
    await removeRuntimeJson(dir);
    expect(await readRuntimeJson(dir)).toBeNull();
  });
});

describe("tcpProbe", () => {
  test("returns true when port is listening", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    expect(await tcpProbe("127.0.0.1", port, 500)).toBe(true);
    server.close();
  });

  test("returns false when nothing is listening", async () => {
    expect(await tcpProbe("127.0.0.1", 1, 200)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- runtimeJson`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/agent-connect/runtimeJson.ts
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";

export interface RuntimeInfo {
  httpHost: string;
  httpPort: number;
  pid: number;
}

function runtimePath(dir: string): string {
  return join(dir, "runtime.json");
}

export async function writeRuntimeJson(dir: string, info: RuntimeInfo): Promise<void> {
  await writeFile(runtimePath(dir), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export async function readRuntimeJson(dir: string): Promise<RuntimeInfo | null> {
  const path = runtimePath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeInfo>;
    if (
      typeof parsed.httpHost !== "string" ||
      typeof parsed.httpPort !== "number" ||
      typeof parsed.pid !== "number"
    ) {
      return null;
    }
    return { httpHost: parsed.httpHost, httpPort: parsed.httpPort, pid: parsed.pid };
  } catch {
    return null;
  }
}

export async function removeRuntimeJson(dir: string): Promise<void> {
  await rm(runtimePath(dir), { force: true });
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- runtimeJson`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/runtimeJson.ts apps/bot/tests/runtimeJson.test.ts
git commit -m "feat(runtime): add runtime.json read/write + tcpProbe helper"
```

---

### Task 1.10: Migration module

**Files:**
- Create: `apps/bot/src/agent-connect/migration.ts`
- Create: `apps/bot/tests/migration.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/bot/tests/migration.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateJsonToSqliteIfNeeded } from "../src/agent-connect/migration.js";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";

let botDir: string;
beforeEach(() => {
  botDir = mkdtempSync(join(tmpdir(), "agc-migration-"));
});

function writeFixtures(args: {
  state?: unknown;
  sessionMap?: unknown;
  monitorState?: unknown;
}) {
  if (args.state) {
    writeFileSync(join(botDir, "state.json"), JSON.stringify(args.state));
  }
  if (args.sessionMap) {
    writeFileSync(join(botDir, "session_map.json"), JSON.stringify(args.sessionMap));
  }
  if (args.monitorState) {
    writeFileSync(join(botDir, "monitor_state.json"), JSON.stringify(args.monitorState));
  }
}

describe("migrateJsonToSqliteIfNeeded", () => {
  test("no-op when bot.sqlite already exists", async () => {
    new Database(join(botDir, "bot.sqlite")).close();
    writeFixtures({ state: { window_states: { "@0": { session_id: "S", cwd: "/a", window_name: "x" } } } });
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    expect(existsSync(join(botDir, "state.json"))).toBe(true); // not renamed
  });

  test("creates schema and skips import when no JSON files", async () => {
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    expect(existsSync(join(botDir, "bot.sqlite"))).toBe(true);
    const db = new Database(join(botDir, "bot.sqlite"));
    const reg = new SessionRegistry(db);
    expect(reg.listLiveWindows()).toEqual([]);
    db.close();
  });

  test("imports windows + sessions + bindings from JSON fixtures", async () => {
    writeFixtures({
      state: {
        window_states: { "@0": { session_id: "S1", cwd: "/proj", window_name: "proj" } },
        window_display_names: { "@0": "proj" },
        thread_bindings: { "123": { "42": "@0" } },
        group_chat_ids: { "123:42": -100200 },
        topic_probe_message_ids: { "123:42": 555 },
        user_window_offsets: { "123": { "@0": 4096 } },
      },
      sessionMap: {
        "tmux-test:@0": { session_id: "S1", cwd: "/proj", window_name: "proj" },
      },
      monitorState: {
        tracked_sessions: { S1: { session_id: "S1", file_path: "/path/S1.jsonl", last_byte_offset: 8192 } },
      },
    });

    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");

    const reg = new SessionRegistry(new Database(join(botDir, "bot.sqlite")));
    expect(reg.listLiveWindows()).toMatchObject([{ window_id: "@0", display_name: "proj", cwd: "/proj" }]);
    expect(reg.getSessionByWindow("@0")).toMatchObject({
      session_id: "S1",
      transcript_path: "/path/S1.jsonl",
      last_byte_offset: 8192,
      cwd: "/proj",
    });
    expect(reg.resolveWindowForThread(123, 42)).toBe("@0");
    expect(reg.resolveChatId(123, 42)).toBe(-100200);
    expect(reg.getTopicProbeMessageId(123, 42)).toBe(555);
    expect(reg.getUserWindowOffset(123, "@0")).toBe(4096);
  });

  test("renames JSON files with .migrated-YYYY-MM-DD suffix", async () => {
    writeFixtures({ state: { window_display_names: {} } });
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    const files = readdirSync(botDir);
    expect(files.some((f) => f.startsWith("state.json.migrated-"))).toBe(true);
    expect(files.includes("state.json")).toBe(false);
  });

  test("running migration twice is a no-op (bot.sqlite already exists)", async () => {
    writeFixtures({ state: { window_display_names: { "@0": "x" }, window_states: { "@0": { session_id: "", cwd: "/a", window_name: "x" } } } });
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    const files = readdirSync(botDir);
    expect(files.filter((f) => f.startsWith("state.json.migrated-"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- migration`
Expected: FAIL.

- [ ] **Step 3: Implement migration**

```ts
// apps/bot/src/agent-connect/migration.ts
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SessionRegistry } from "./sessionRegistry.js";
import type { AgentType } from "./hookTypes.js";

interface StateJson {
  window_states?: Record<string, { session_id?: string; cwd?: string; window_name?: string }>;
  window_display_names?: Record<string, string>;
  thread_bindings?: Record<string, Record<string, string>>;
  group_chat_ids?: Record<string, number>;
  topic_probe_message_ids?: Record<string, number>;
  user_window_offsets?: Record<string, Record<string, number>>;
}

interface SessionMapJson {
  [key: string]: { session_id?: string; cwd?: string; window_name?: string } | undefined;
}

interface MonitorStateJson {
  tracked_sessions?: Record<string, { session_id?: string; file_path?: string; last_byte_offset?: number }>;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function migrateJsonToSqliteIfNeeded(
  botDir: string,
  tmuxSessionName: string,
  agentType: AgentType = "claude"
): Promise<void> {
  const dbPath = join(botDir, "bot.sqlite");
  if (existsSync(dbPath)) return;

  const stateFile = join(botDir, "state.json");
  const sessionMapFile = join(botDir, "session_map.json");
  const monitorStateFile = join(botDir, "monitor_state.json");
  const hasAnyJson = existsSync(stateFile) || existsSync(sessionMapFile) || existsSync(monitorStateFile);

  // Always create the DB and schema
  const db = new Database(dbPath);
  const registry = new SessionRegistry(db);

  if (!hasAnyJson) {
    db.close();
    return;
  }

  const state = (await readJsonOrNull<StateJson>(stateFile)) ?? {};
  const sessionMap = (await readJsonOrNull<SessionMapJson>(sessionMapFile)) ?? {};
  const monitorState = (await readJsonOrNull<MonitorStateJson>(monitorStateFile)) ?? {};

  const prefix = `${tmuxSessionName}:`;
  const tx = db.transaction(() => {
    // 1. windows from display_names
    const displayNames = state.window_display_names ?? {};
    for (const [windowId, name] of Object.entries(displayNames)) {
      if (!windowId.startsWith("@")) continue;
      const cwd =
        state.window_states?.[windowId]?.cwd ??
        sessionMap[`${prefix}${windowId}`]?.cwd ??
        "";
      if (!cwd) continue;
      registry.upsertWindow(windowId, name, cwd);
    }

    // 2. sessions from session_map; offsets from monitor_state
    for (const [key, info] of Object.entries(sessionMap)) {
      if (!key.startsWith(prefix) || !info) continue;
      const windowId = key.slice(prefix.length);
      if (!windowId.startsWith("@") || !info.session_id || !info.cwd) continue;
      // window row must exist before session insert (FK)
      if (!registry.listLiveWindows().some((w) => w.window_id === windowId)) {
        registry.upsertWindow(windowId, info.window_name ?? windowId, info.cwd);
      }
      const tracked = monitorState.tracked_sessions?.[info.session_id];
      registry.registerSession({
        sessionId: info.session_id,
        windowId,
        agentType,
        transcriptPath: tracked?.file_path ?? "",
        cwd: info.cwd,
        source: "startup",
        lastByteOffset: tracked?.last_byte_offset ?? 0,
      });
    }

    // 3. thread_bindings + group_chat_ids + topic_probe_message_ids
    for (const [userKey, bindings] of Object.entries(state.thread_bindings ?? {})) {
      const userId = Number(userKey);
      if (!Number.isFinite(userId)) continue;
      for (const [threadKey, windowId] of Object.entries(bindings)) {
        const threadId = Number(threadKey);
        if (!Number.isFinite(threadId)) continue;
        if (!registry.listLiveWindows().some((w) => w.window_id === windowId)) continue;
        registry.bindThread(userId, threadId, windowId);
        const chatKey = `${userId}:${threadId}`;
        const chatId = state.group_chat_ids?.[chatKey];
        if (typeof chatId === "number") registry.setGroupChatId(userId, threadId, chatId);
        const probeId = state.topic_probe_message_ids?.[chatKey];
        if (typeof probeId === "number") registry.setTopicProbeMessageId(userId, threadId, probeId);
      }
    }

    // 4. user_window_offsets
    for (const [userKey, offsets] of Object.entries(state.user_window_offsets ?? {})) {
      const userId = Number(userKey);
      if (!Number.isFinite(userId)) continue;
      for (const [windowId, offset] of Object.entries(offsets)) {
        if (!registry.listLiveWindows().some((w) => w.window_id === windowId)) continue;
        registry.updateUserWindowOffset(userId, windowId, Number(offset));
      }
    }

    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
      "migrated_from_json_at",
      String(Date.now())
    );
  });

  try {
    tx();
  } catch (error) {
    db.close();
    // Roll back: drop the half-built sqlite so a retry starts clean
    const fs = await import("node:fs/promises");
    await fs.rm(dbPath, { force: true });
    throw error;
  }
  db.close();

  // Rename JSON files only after successful import
  const stamp = todayStamp();
  for (const path of [stateFile, sessionMapFile, monitorStateFile]) {
    if (existsSync(path)) {
      await rename(path, `${path}.migrated-${stamp}`);
    }
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- migration`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/migration.ts apps/bot/tests/migration.test.ts
git commit -m "feat(migration): one-shot JSON to SQLite importer"
```

---

### Task 1.11: PR-1 close — typecheck + full test sweep

- [ ] **Step 1: Full typecheck**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: 0 errors.

- [ ] **Step 2: Full test run**

Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: all green (new tests pass; existing tests untouched).

- [ ] **Step 3: Push PR-1**

```bash
git push -u origin hook-refactor
gh pr create --title "PR-1: Add SessionRegistry + migration infrastructure" --body "$(cat <<'EOF'
## Summary
- Add `SessionRegistry` (SQLite-backed) with windows/sessions/bindings/offsets CRUD
- Add `withSessionLock` per-session in-memory mutex
- Add `runtimeJson` helper + `tcpProbe`
- Add `migration` module: one-shot import from `state.json` / `session_map.json` / `monitor_state.json`
- No call sites changed; old `SessionMonitor` still runs

## Test plan
- [x] `pnpm test:ts` green
- [x] `pnpm typecheck` green
EOF
)"
```

---

# PR-2: Hook Plumbing (Router + Client + Installer + drainTranscript)

Still pure additions plus a Fastify endpoint. Old monitor still runs.

---

### Task 2.1: drainTranscript module

**Files:**
- Create: `apps/bot/src/agent-connect/drainTranscript.ts`
- Create: `apps/bot/tests/drainTranscript.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/bot/tests/drainTranscript.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { drainTranscript, type Dispatcher } from "../src/agent-connect/drainTranscript.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { writeFakeTranscript, appendToTranscript } from "./helpers/transcriptFixtures.js";

interface DispatchCall {
  windowId: string;
  count: number;
  texts: string[];
}

function setup() {
  const reg = new SessionRegistry(inMemoryDb());
  reg.upsertWindow("@0", "x", "/a");
  const calls: DispatchCall[] = [];
  const dispatcher: Dispatcher = async (windowId, entries) => {
    calls.push({
      windowId,
      count: entries.length,
      texts: entries.map((e) => e.text),
    });
  };
  return { reg, calls, dispatcher };
}

describe("drainTranscript", () => {
  test("no-op when transcript_path is empty", async () => {
    const { reg, calls, dispatcher } = setup();
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: "", cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toEqual([]);
  });

  test("no-op when file does not exist", async () => {
    const { reg, calls, dispatcher } = setup();
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: "/no/such/file.jsonl", cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toEqual([]);
  });

  test("reads new entries and advances offset", async () => {
    const { reg, calls, dispatcher } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "hello world" }] } },
    ]);
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: path, cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ windowId: "@0", count: 1, texts: ["hello world"] });
    const offsetAfter = reg.getSession("S")!.last_byte_offset;
    expect(offsetAfter).toBeGreaterThan(0);
  });

  test("second call delivers only new content", async () => {
    const { reg, calls, dispatcher } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    ]);
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: path, cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    await appendToTranscript(path, [
      { type: "assistant", message: { content: [{ type: "text", text: "second" }] } },
    ]);
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(2);
    expect(calls[1].texts).toEqual(["second"]);
  });

  test("file truncation resets offset and re-reads", async () => {
    const { reg, calls, dispatcher } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    ]);
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: path, cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    // External truncation + new content with smaller size
    await writeFile(path, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "afterTrunc" }] } }) + "\n", "utf8");
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(2);
    expect(calls[1].texts).toEqual(["afterTrunc"]);
  });

  test("skips unknown session id", async () => {
    const { reg, calls, dispatcher } = setup();
    await drainTranscript(reg, dispatcher, "UNKNOWN");
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- drainTranscript`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/agent-connect/drainTranscript.ts
import { open, stat } from "node:fs/promises";
import { TranscriptParser, type PendingToolInfo } from "./transcriptParser.js";
import type { SessionRegistry, SessionRow } from "./sessionRegistry.js";

export interface NewMessageLike {
  sessionId: string;
  windowId: string;
  text: string;
  isComplete: boolean;
  contentType: string;
  toolUseId?: string | null;
  role: "user" | "assistant";
  toolName?: string | null;
  imageData?: unknown;
}

export type Dispatcher = (windowId: string, entries: NewMessageLike[]) => Promise<void>;

const pendingToolsCache = new Map<string, Record<string, PendingToolInfo>>();

export function _resetPendingForTests(): void {
  pendingToolsCache.clear();
}

export async function drainTranscript(
  registry: SessionRegistry,
  dispatcher: Dispatcher,
  sessionId: string
): Promise<void> {
  if (!registry.getSession(sessionId)) return;

  return registry.withSessionLock(sessionId, async (session: SessionRow) => {
    if (!session.transcript_path) return;

    let info;
    try {
      info = await stat(session.transcript_path);
    } catch {
      return;
    }

    let startOffset = session.last_byte_offset;
    if (info.size < startOffset) {
      registry.setOffset(sessionId, 0);
      pendingToolsCache.delete(sessionId);
      startOffset = 0;
    }
    if (info.size <= startOffset) return;

    const buf = Buffer.alloc(info.size - startOffset);
    const handle = await open(session.transcript_path, "r");
    try {
      await handle.read(buf, 0, buf.length, startOffset);
    } finally {
      await handle.close();
    }

    let safeEnd = startOffset;
    const entries: Record<string, unknown>[] = [];
    let cursor = 0;
    while (cursor < buf.length) {
      const nl = buf.indexOf(0x0a, cursor);
      const lineEnd = nl === -1 ? buf.length : nl;
      const raw = buf.subarray(cursor, lineEnd).toString("utf8");
      const parsed = TranscriptParser.parseLine(raw);
      if (parsed) {
        entries.push(parsed);
        safeEnd = startOffset + lineEnd + (nl === -1 ? 0 : 1);
      } else if (raw.trim()) {
        break;
      } else {
        safeEnd = startOffset + lineEnd + (nl === -1 ? 0 : 1);
      }
      if (nl === -1) break;
      cursor = nl + 1;
    }

    const carry = pendingToolsCache.get(sessionId) ?? {};
    const [parsedEntries, remaining] = TranscriptParser.parseEntries(entries, carry);
    if (Object.keys(remaining).length > 0) {
      pendingToolsCache.set(sessionId, remaining);
    } else {
      pendingToolsCache.delete(sessionId);
    }

    registry.setOffset(sessionId, safeEnd);

    const messages: NewMessageLike[] = parsedEntries
      .filter((e) => e.text || e.imageData)
      .map((e) => ({
        sessionId,
        windowId: session.window_id,
        text: e.text,
        isComplete: true,
        contentType: e.contentType,
        toolUseId: e.toolUseId ?? null,
        role: e.role,
        toolName: e.toolName ?? null,
        imageData: e.imageData ?? null,
      }));

    if (messages.length > 0) {
      await dispatcher(session.window_id, messages);
    }
  });
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- drainTranscript`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/drainTranscript.ts apps/bot/tests/drainTranscript.test.ts
git commit -m "feat(transcript): add drainTranscript with per-session lock + truncation handling"
```

---

### Task 2.2: HookRouter — dispatch skeleton + SessionStart

**Files:**
- Create: `apps/bot/src/agent-connect/hookRouter.ts`
- Create: `apps/bot/tests/hookRouter.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/bot/tests/hookRouter.test.ts
import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";
import type { Dispatcher } from "../src/agent-connect/drainTranscript.js";

function setup() {
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
    await router.dispatch(envelope("SessionStart", {
      session_id: "S1",
      transcript_path: "/tmp/S1.jsonl",
      cwd: "/proj",
      source: "startup",
    }, { window_id: "@0", window_name: "proj" }));
    const win = registry.listLiveWindows();
    expect(win).toMatchObject([{ window_id: "@0", display_name: "proj", cwd: "/proj" }]);
    expect(registry.getSession("S1")).toMatchObject({
      window_id: "@0",
      transcript_path: "/tmp/S1.jsonl",
      source: "startup",
      last_byte_offset: 0,
    });
  });

  test("SessionStart for same window replaces session", async () => {
    const { registry, router } = setup();
    await router.dispatch(envelope("SessionStart", { session_id: "S1", transcript_path: "/p1", cwd: "/a" }, { window_id: "@0" }));
    await router.dispatch(envelope("SessionStart", { session_id: "S2", transcript_path: "/p2", cwd: "/a" }, { window_id: "@0" }));
    expect(registry.getSession("S1")).toBeNull();
    expect(registry.getSessionByWindow("@0")?.session_id).toBe("S2");
  });

  test("ignores unknown hook event names without throwing", async () => {
    const { router } = setup();
    await router.dispatch(envelope("InstructionsLoaded" as never));
    // no throw, no side effect
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookRouter`
Expected: FAIL — `HookRouter` not found.

- [ ] **Step 3: Implement skeleton**

```ts
// apps/bot/src/agent-connect/hookRouter.ts
import type { SessionRegistry } from "./sessionRegistry.js";
import type { Dispatcher } from "./drainTranscript.js";
import { drainTranscript } from "./drainTranscript.js";
import type { AgentType, HookEnvelope, HookEventName } from "./hookTypes.js";

export interface HookRouterDeps {
  registry: SessionRegistry;
  dispatcher: Dispatcher;
  agentType: AgentType;
}

export class HookRouter {
  private readonly windowQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: HookRouterDeps) {}

  dispatch(envelope: HookEnvelope): Promise<void> {
    const key = envelope.window_id;
    const prev = this.windowQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.handleOne(envelope)).catch((err) => {
      console.warn("[hookRouter]", err);
    });
    this.windowQueues.set(key, next);
    next.finally(() => {
      if (this.windowQueues.get(key) === next) this.windowQueues.delete(key);
    });
    return next as Promise<void>;
  }

  private async handleOne(envelope: HookEnvelope): Promise<void> {
    const event = envelope.payload.hook_event_name as HookEventName;
    switch (event) {
      case "SessionStart":
        return this.onSessionStart(envelope);
      default:
        return;
    }
  }

  private async onSessionStart(envelope: HookEnvelope): Promise<void> {
    const { registry } = this.deps;
    const { payload } = envelope;
    registry.upsertWindow(envelope.window_id, envelope.window_name, payload.cwd);
    registry.registerSession({
      sessionId: payload.session_id,
      windowId: envelope.window_id,
      agentType: this.deps.agentType,
      transcriptPath: payload.transcript_path ?? "",
      cwd: payload.cwd,
      source: typeof payload.source === "string" ? payload.source : undefined,
    });
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookRouter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/hookRouter.ts apps/bot/tests/hookRouter.test.ts
git commit -m "feat(hook): add HookRouter skeleton with SessionStart handler"
```

---

### Task 2.3: HookRouter — drain-triggering events (Stop, PostToolUse, etc.)

**Files:**
- Modify: `apps/bot/src/agent-connect/hookRouter.ts`
- Modify: `apps/bot/tests/hookRouter.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { writeFakeTranscript } from "./helpers/transcriptFixtures.js";

describe("HookRouter drain-triggering events", () => {
  test("Stop drains transcript and dispatches", async () => {
    const { registry, router, dispatched } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    ]);
    await router.dispatch(envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    await router.dispatch(envelope("Stop", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    expect(dispatched).toContainEqual({ windowId: "@0", count: 1 });
  });

  test("PostToolUse, PostToolBatch, PostToolUseFailure, UserPromptSubmit, SessionEnd all trigger drain", async () => {
    for (const event of ["PostToolUse", "PostToolBatch", "PostToolUseFailure", "UserPromptSubmit", "SessionEnd"] as const) {
      const { registry, router, dispatched } = setup();
      const path = await writeFakeTranscript([
        { type: "assistant", message: { content: [{ type: "text", text: `via-${event}` }] } },
      ]);
      await router.dispatch(envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
      const before = dispatched.length;
      await router.dispatch(envelope(event, { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
      expect(dispatched.length).toBeGreaterThan(before);
    }
  });

  test("SessionEnd also deletes the session row after drain", async () => {
    const { registry, router } = setup();
    const path = await writeFakeTranscript([]);
    await router.dispatch(envelope("SessionStart", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    await router.dispatch(envelope("SessionEnd", { session_id: "S", transcript_path: path, cwd: "/a" }, { window_id: "@0" }));
    expect(registry.getSession("S")).toBeNull();
  });

  test("event for unregistered session does not throw", async () => {
    const { router, dispatched } = setup();
    await router.dispatch(envelope("Stop", { session_id: "UNKNOWN" }, { window_id: "@9" }));
    expect(dispatched).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookRouter`
Expected: FAIL.

- [ ] **Step 3: Extend handler switch**

Replace `handleOne` in `hookRouter.ts`:

```ts
private async handleOne(envelope: HookEnvelope): Promise<void> {
  const event = envelope.payload.hook_event_name as HookEventName;
  switch (event) {
    case "SessionStart":
      return this.onSessionStart(envelope);
    case "SessionEnd":
      return this.onSessionEnd(envelope);
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolBatch":
    case "PostToolUseFailure":
    case "Stop":
      return this.onDrain(envelope);
    case "PreToolUse":
    case "Notification":
    case "PermissionRequest":
      // Status updates — handled in next task
      return;
    default:
      return;
  }
}

private async onDrain(envelope: HookEnvelope): Promise<void> {
  const sessionId = envelope.payload.session_id;
  await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
}

private async onSessionEnd(envelope: HookEnvelope): Promise<void> {
  const sessionId = envelope.payload.session_id;
  await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
  this.deps.registry.endSession(sessionId);
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookRouter`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/hookRouter.ts apps/bot/tests/hookRouter.test.ts
git commit -m "feat(hook): dispatch Stop / PostToolUse / SessionEnd / etc to drainTranscript"
```

---

### Task 2.4: HookRouter — per-window queue (ordering test)

**Files:**
- Modify: `apps/bot/tests/hookRouter.test.ts`

- [ ] **Step 1: Append failing test for ordering**

```ts
describe("HookRouter per-window queue", () => {
  test("SessionStart completes before subsequent Stop even when dispatched out of order", async () => {
    const { registry, router } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    ]);
    // Dispatch SessionStart but DO NOT await yet.
    const startP = router.dispatch(envelope(
      "SessionStart",
      { session_id: "S", transcript_path: path, cwd: "/a" },
      { window_id: "@0" }
    ));
    // Immediately dispatch Stop (should queue behind SessionStart).
    const stopP = router.dispatch(envelope(
      "Stop",
      { session_id: "S", transcript_path: path, cwd: "/a" },
      { window_id: "@0" }
    ));
    await Promise.all([startP, stopP]);
    expect(registry.getSession("S")).not.toBeNull();
    // Drain happened after registration succeeded
    expect(registry.getSession("S")!.last_byte_offset).toBeGreaterThan(0);
  });

  test("different windows process in parallel", async () => {
    const { registry, router } = setup();
    const path1 = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "w0" }] } },
    ]);
    const path2 = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "w1" }] } },
    ]);
    await Promise.all([
      router.dispatch(envelope("SessionStart", { session_id: "A", transcript_path: path1, cwd: "/a" }, { window_id: "@0" })),
      router.dispatch(envelope("SessionStart", { session_id: "B", transcript_path: path2, cwd: "/b" }, { window_id: "@1" })),
    ]);
    expect(registry.getSession("A")).not.toBeNull();
    expect(registry.getSession("B")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests (expect pass — already implemented)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookRouter`
Expected: all PASS (the per-window queue is already in place from Task 2.2).

- [ ] **Step 3: Commit**

```bash
git add apps/bot/tests/hookRouter.test.ts
git commit -m "test(hook): per-window queue ordering"
```

---

### Task 2.5: hookInstaller — split from hook.ts (events parameter)

**Files:**
- Create: `apps/bot/src/agent-connect/hookInstaller.ts`
- Modify: existing `apps/bot/src/agent-connect/hook.ts` (will be deleted in PR-4, but for now we keep it side-by-side)

- [ ] **Step 1: Copy installer logic into new file**

Read the install-related functions from `apps/bot/src/agent-connect/hook.ts` (lines roughly 60-300 covering `isHookInstalled`, `installHook`, `installCodexHook`, `installAllHooks`, `syncHookSettings`, `syncCodexHooksFeatureFlag`, `resolveHookCommand`, `isAgentConnectHookCommand`, etc.) and copy them verbatim into `hookInstaller.ts`. Keep all helpers (`shellQuote`, `withHookEnv`, `findAgcPath`, `findConfigDirForTmuxSession`, `parseTmuxWindowInfo`, etc.) that the install functions depend on.

Do NOT copy `hookMain` or `processHookEvent` — those belong in PR-2 Task 2.7 (`hookClient.ts`).

After copy, change the function signature of `syncHookSettings` to:

```ts
export function syncHookSettings(
  settings: JsonRecord,
  hookCommand: string,
  options: { events?: string[]; matcher?: string } = {}
): boolean {
  const events = options.events && options.events.length > 0 ? options.events : ["SessionStart"];
  // ... rest of logic iterates over events instead of always doing SessionStart
}
```

Then update the loop inside `syncHookSettings` to iterate `events` and register the hook command under each event key. Use the existing logic (find or insert agent-connect hook entry) for each event.

- [ ] **Step 2: Add a test for the events array**

Create `apps/bot/tests/hookInstaller.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { syncHookSettings } from "../src/agent-connect/hookInstaller.js";

describe("syncHookSettings events parameter", () => {
  test("installs hook command under each named event", () => {
    const settings: Record<string, unknown> = {};
    syncHookSettings(settings, "agc hook", { events: ["SessionStart", "Stop", "PostToolUse"] });
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    expect(hooks.SessionStart).toBeTruthy();
    expect(hooks.Stop).toBeTruthy();
    expect(hooks.PostToolUse).toBeTruthy();
  });

  test("is idempotent — running twice produces same result", () => {
    const settings: Record<string, unknown> = {};
    syncHookSettings(settings, "agc hook", { events: ["SessionStart", "Stop"] });
    const snapshot = JSON.stringify(settings);
    syncHookSettings(settings, "agc hook", { events: ["SessionStart", "Stop"] });
    expect(JSON.stringify(settings)).toBe(snapshot);
  });

  test("preserves unrelated user hooks", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo unrelated" }] },
        ],
      },
    };
    syncHookSettings(settings, "agc hook", { events: ["Stop"] });
    const stopEntries = ((settings.hooks as Record<string, unknown[]>).Stop) as Array<{
      hooks: Array<{ command: string }>;
    }>;
    const allCommands = stopEntries.flatMap((e) => e.hooks.map((h) => h.command));
    expect(allCommands).toContain("echo unrelated");
    expect(allCommands).toContain("agc hook");
  });

  test("applies matcher option only to first entry when given", () => {
    const settings: Record<string, unknown> = {};
    syncHookSettings(settings, "agc hook", { events: ["SessionStart"], matcher: "startup|resume|clear|compact" });
    const entries = ((settings.hooks as Record<string, unknown[]>).SessionStart) as Array<{ matcher?: string }>;
    expect(entries[0]?.matcher).toBe("startup|resume|clear|compact");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookInstaller`
Expected: PASS.

- [ ] **Step 4: Update `installHook` / `installCodexHook` to pass full event lists**

In `hookInstaller.ts`, change `installHook` body to call:

```ts
const changed = syncHookSettings(settings, hookCommand, {
  events: [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolBatch",
    "PostToolUseFailure",
    "Stop",
    "Notification",
  ],
  matcher: undefined,  // matcher only meaningful on SessionStart; handle separately
});
```

Add a second call inside `installHook` (or modify `syncHookSettings` to accept per-event matchers) so that `SessionStart` carries `matcher: "startup|resume|clear|compact"`. Simplest path: after the main `syncHookSettings` call, do:

```ts
syncHookSettings(settings, hookCommand, { events: ["SessionStart"], matcher: "startup|resume|clear|compact" });
```

(The function is idempotent so the second call just sets the matcher on the existing entry.)

For `installCodexHook`, change the events list to:

```ts
events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"],
```

with `matcher: "startup|resume|clear"` for SessionStart in a second call.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/agent-connect/hookInstaller.ts apps/bot/tests/hookInstaller.test.ts
git commit -m "feat(hook): split installer with events array; install Claude+Codex event lists"
```

---

### Task 2.6: hookClient — CLI that POSTs envelope

**Files:**
- Create: `apps/bot/src/agent-connect/hookClient.ts`

- [ ] **Step 1: Write client**

```ts
// apps/bot/src/agent-connect/hookClient.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { Readable, type Writable } from "node:stream";
import { agentConnectDir } from "./utils.js";
import { readRuntimeJson } from "./runtimeJson.js";

const execFileAsync = promisify(execFile);

interface TmuxInfo {
  tmuxSession: string;
  windowId: string;
  windowName: string;
}

async function readStdin(stdin: Readable): Promise<string> {
  let buf = "";
  for await (const chunk of stdin) buf += chunk;
  return buf;
}

async function tmuxInfo(env: NodeJS.ProcessEnv): Promise<TmuxInfo | null> {
  const pane = env.TMUX_PANE;
  if (!pane) return null;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-t", pane, "-p", "#{session_name}:#{window_id}:#{window_name}"],
      { encoding: "utf8" }
    );
    const trimmed = stdout.trim();
    const first = trimmed.indexOf(":");
    const second = first >= 0 ? trimmed.indexOf(":", first + 1) : -1;
    if (first < 0 || second < 0) return null;
    return {
      tmuxSession: trimmed.slice(0, first),
      windowId: trimmed.slice(first + 1, second),
      windowName: trimmed.slice(second + 1),
    };
  } catch {
    return null;
  }
}

function postEnvelope(
  host: string,
  port: number,
  body: string,
  timeoutMs = 2000
): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      {
        host,
        port,
        method: "POST",
        path: "/hook/events",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      }
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

export async function runHookClient(
  stdin: Readable = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
  _stdout: Writable = process.stdout,
  _stderr: Writable = process.stderr
): Promise<number> {
  const raw = (await readStdin(stdin)).trim();
  if (!raw) return 0;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const info = await tmuxInfo(env);
  if (!info) return 0;
  const runtime = await readRuntimeJson(agentConnectDir(env));
  if (!runtime) return 0;
  const envelope = {
    tmux_session: info.tmuxSession,
    window_id: info.windowId,
    window_name: info.windowName,
    payload,
  };
  await postEnvelope(runtime.httpHost, runtime.httpPort, JSON.stringify(envelope));
  return 0;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/bot/src/agent-connect/hookClient.ts
git commit -m "feat(hook): add hookClient (stdin payload + tmux info -> POST /hook/events)"
```

---

### Task 2.7: Fastify `/hook/events` endpoint + integration test

**Files:**
- Modify: `apps/bot/src/agent-connect/server.ts`
- Create: `apps/bot/tests/hookServer.test.ts`

- [ ] **Step 1: Write integration test using fastify.inject**

```ts
// apps/bot/tests/hookServer.test.ts
import { describe, test, expect } from "vitest";
import Fastify from "fastify";
import { registerHookEndpoint } from "../src/agent-connect/server.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

function setup() {
  const registry = new SessionRegistry(inMemoryDb());
  const dispatched: unknown[] = [];
  const router = new HookRouter({
    registry,
    dispatcher: async (windowId, entries) => { dispatched.push({ windowId, count: entries.length }); },
    agentType: "claude",
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
      payload: envelope("SessionStart", { session_id: "S", transcript_path: "/p", cwd: "/a" }),
    });
    expect(reply.statusCode).toBe(202);
  });

  test("processes envelope asynchronously and updates registry", async () => {
    const { fastify, registry } = setup();
    await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: envelope("SessionStart", { session_id: "S", transcript_path: "/p", cwd: "/a" }, { window_id: "@7" }),
    });
    // Wait one tick for setImmediate
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(registry.getSessionByWindow("@7")?.session_id).toBe("S");
  });

  test("returns 400 on malformed body", async () => {
    const { fastify } = setup();
    const reply = await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: { foo: "bar" },
    });
    expect(reply.statusCode).toBe(400);
  });

  test("silently drops envelope for unknown tmux_session", async () => {
    const { fastify, dispatched } = setup();
    const reply = await fastify.inject({
      method: "POST",
      url: "/hook/events",
      payload: envelope("SessionStart", {}, { tmux_session: "other" }),
    });
    expect(reply.statusCode).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(dispatched).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookServer`
Expected: FAIL — `registerHookEndpoint` not exported.

- [ ] **Step 3: Add `registerHookEndpoint` to `server.ts`**

Add this exported function near the top of `server.ts` (after imports):

```ts
import type { FastifyInstance } from "fastify";
import type { HookRouter } from "./hookRouter.js";
import type { HookEnvelope } from "./hookTypes.js";

export type HookRouterLookup = (tmuxSession: string) => HookRouter | null;

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
      const envelope = body as HookEnvelope;
      setImmediate(() => {
        router.dispatch(envelope).catch((err) => console.warn("[hookEndpoint]", err));
      });
    }
    return reply.code(202).send();
  });
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- hookServer`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/server.ts apps/bot/tests/hookServer.test.ts
git commit -m "feat(server): add POST /hook/events endpoint with router lookup"
```

---

### Task 2.8: PR-2 close — typecheck + test sweep

- [ ] **Step 1: Full typecheck**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: 0 errors.

- [ ] **Step 2: Full test run**

Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: all green.

- [ ] **Step 3: Push PR-2**

```bash
git push
gh pr create --title "PR-2: Add HookRouter + drainTranscript + Fastify /hook/events" --body "$(cat <<'EOF'
## Summary
- Add `drainTranscript`: read jsonl from offset to EOF inside per-session lock
- Add `HookRouter`: per-window queue, dispatch SessionStart/Stop/PostToolUse/etc
- Split `hookInstaller` from old `hook.ts`; accept events array
- Add `hookClient` (stdin -> tmux info -> POST envelope)
- Add Fastify `POST /hook/events` endpoint (202-then-async)

## Test plan
- [x] All new unit + integration tests green
- [x] Existing monitor still runs (no wiring change yet)
EOF
)"
```

---

# PR-3: Switch Wiring (Cutover — Regression Tests Must Pass)

The critical hop. Replaces `SessionMonitor` with `HookRouter` in `multiBotRuntime`. Both regression tests must FAIL on `main` and PASS after this PR.

---

### Task 3.1: Regression test — first-response race (RED first)

**Files:**
- Create: `apps/bot/tests/regression-first-response-race.test.ts`

- [ ] **Step 1: Write the test**

```ts
// apps/bot/tests/regression-first-response-race.test.ts
import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { writeFakeTranscript } from "./helpers/transcriptFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

describe("regression: first response race", () => {
  test("fast assistant reply written before any polling tick is delivered", async () => {
    const registry = new SessionRegistry(inMemoryDb());
    const dispatched: Array<{ text: string; role: string; contentType: string }> = [];
    const router = new HookRouter({
      registry,
      dispatcher: async (_w, entries) => {
        for (const e of entries) dispatched.push({ text: e.text, role: e.role, contentType: e.contentType });
      },
      agentType: "claude",
    });

    // Simulate fast Claude: transcript already contains user prompt + complete reply
    // before any hook arrives.
    const path = await writeFakeTranscript([
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } },
    ]);

    await router.dispatch(envelope(
      "SessionStart",
      { session_id: "X", transcript_path: path, cwd: "/a", source: "startup" },
      { window_id: "@0" }
    ));
    await router.dispatch(envelope(
      "Stop",
      { session_id: "X", transcript_path: path, cwd: "/a" },
      { window_id: "@0" }
    ));

    expect(dispatched).toContainEqual({ text: "Hi!", role: "assistant", contentType: "text" });
  });
});
```

- [ ] **Step 2: Run on hook-refactor branch (expect pass — new code already in place)**

Run: `pnpm --filter @agent-connect/bot test:ts -- regression-first-response-race`
Expected: PASS.

- [ ] **Step 3: Verify it would fail on main**

```bash
git stash push -u -m "wip-regression-test"
git checkout main -- apps/bot/src/agent-connect/  # bring back old monitor code
# In old code, there was no HookRouter, so the test would not even compile.
# Verify by attempting test; expect compile failure or assertion failure.
pnpm --filter @agent-connect/bot test:ts -- regression-first-response-race || echo "EXPECTED: fails on main"
git checkout HEAD -- apps/bot/src/agent-connect/  # restore hook-refactor code
git stash pop
```

- [ ] **Step 4: Commit**

```bash
git add apps/bot/tests/regression-first-response-race.test.ts
git commit -m "test(regression): first response race — assistant text delivered via hook drain"
```

---

### Task 3.2: Regression test — resume-session mismatch

**Files:**
- Create: `apps/bot/tests/regression-resume-session-mismatch.test.ts`

- [ ] **Step 1: Write the test**

```ts
// apps/bot/tests/regression-resume-session-mismatch.test.ts
import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { writeFakeTranscript, appendToTranscript } from "./helpers/transcriptFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

describe("regression: resume session id mismatch", () => {
  test("hook reports a different session_id than the transcript filename — bot follows transcript_path", async () => {
    const registry = new SessionRegistry(inMemoryDb());
    const dispatched: string[] = [];
    const router = new HookRouter({
      registry,
      dispatcher: async (_w, entries) => {
        for (const e of entries) dispatched.push(e.text);
      },
      agentType: "claude",
    });

    // The file is named after the *original* session id "X", but the hook will report a NEW id "Y".
    const transcriptX = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "prior turn" }] } },
    ], { sessionId: "X" });

    await router.dispatch(envelope(
      "SessionStart",
      { session_id: "Y", transcript_path: transcriptX, cwd: "/a", source: "resume" },
      { window_id: "@0" }
    ));

    // Claude continues writing to X.jsonl after resume
    await appendToTranscript(transcriptX, [
      { type: "user", message: { content: "hi again" } },
      { type: "assistant", message: { content: [{ type: "text", text: "resumed reply" }] } },
    ]);

    await router.dispatch(envelope(
      "Stop",
      { session_id: "Y", transcript_path: transcriptX, cwd: "/a" },
      { window_id: "@0" }
    ));

    expect(dispatched).toContain("resumed reply");
    const row = registry.getSessionByWindow("@0")!;
    expect(row.session_id).toBe("Y");
    expect(row.transcript_path).toBe(transcriptX);
  });
});
```

- [ ] **Step 2: Run (expect pass)**

Run: `pnpm --filter @agent-connect/bot test:ts -- regression-resume-session-mismatch`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/bot/tests/regression-resume-session-mismatch.test.ts
git commit -m "test(regression): resume id mismatch — bot trusts transcript_path from hook"
```

---

### Task 3.3: sessionLookup.ts — extract /history reads from session.ts

**Files:**
- Create: `apps/bot/src/agent-connect/sessionLookup.ts`

- [ ] **Step 1: Copy lookup functions verbatim**

Copy these methods from existing `session.ts` into a new module:

- `buildSessionFilePath`
- `getSessionDirect`
- `listSessionsForDirectory`
- `findSessionFileByGlob`
- `encodeCwd`
- `getRecentMessages` (the parts that do `readFile` + `TranscriptParser.parseEntries`)

Convert them from class methods to standalone exported functions that take `(claudeProjectsPath, codexHomePath, agentType, registry)` as parameters where needed (instead of using `this`).

Skeleton:

```ts
// apps/bot/src/agent-connect/sessionLookup.ts
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, statSync } from "node:path"; // statSync from fs
import { findCodexSession, listCodexSessionsForDirectory } from "./codexSessions.js";
import type { AgentType } from "./hookTypes.js";
import { TranscriptParser } from "./transcriptParser.js";
import type { SessionRegistry } from "./sessionRegistry.js";

export interface SessionSummary {
  sessionId: string;
  summary: string;
  messageCount: number;
  filePath: string;
  agentType?: AgentType;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  contentType: string;
  timestamp?: string | null;
}

export interface LookupConfig {
  claudeProjectsPath: string;
  codexHomePath: string;
  agentType: AgentType;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function buildSessionFilePath(config: LookupConfig, sessionId: string, cwd: string): string | null {
  if (!sessionId || !cwd) return null;
  return join(config.claudeProjectsPath, encodeCwd(cwd), `${sessionId}.jsonl`);
}

// ... reproduce getSessionDirect / listSessionsForDirectory / getRecentMessages / findSessionFileByGlob
// using `config` and `registry` parameters where the old SessionManager used `this`
```

(The exhaustive copy is mechanical; preserve behavior. Tests will verify.)

- [ ] **Step 2: Add minimal smoke test**

```ts
// apps/bot/tests/sessionLookup.test.ts
import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionsForDirectory } from "../src/agent-connect/sessionLookup.js";

describe("sessionLookup.listSessionsForDirectory", () => {
  test("returns claude sessions for a project directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "agc-lookup-"));
    const projectsPath = join(root, "projects");
    const cwd = "/work/example";
    const dirName = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
    mkdirSync(join(projectsPath, dirName), { recursive: true });
    writeFileSync(
      join(projectsPath, dirName, "abc.jsonl"),
      JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n"
    );
    const sessions = await listSessionsForDirectory(
      { claudeProjectsPath: projectsPath, codexHomePath: "", agentType: "claude" },
      cwd
    );
    expect(sessions.map((s) => s.sessionId)).toContain("abc");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-connect/bot test:ts -- sessionLookup`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/agent-connect/sessionLookup.ts apps/bot/tests/sessionLookup.test.ts
git commit -m "feat(history): extract sessionLookup module from session.ts"
```

---

### Task 3.4: multiBotRuntime — instantiate Registry + HookRouter per bot

**Files:**
- Modify: `apps/bot/src/agent-connect/multiBotRuntime.ts`

- [ ] **Step 1: Read current `multiBotRuntime.ts`**

Read the file. Identify where `SessionMonitor` is created and wired.

- [ ] **Step 2: Replace SessionMonitor with HookRouter**

Inside the per-bot `start()` (or equivalent):

1. Add: `import { SessionRegistry } from "./sessionRegistry.js"; import { HookRouter } from "./hookRouter.js"; import { migrateJsonToSqliteIfNeeded } from "./migration.js"; import Database from "better-sqlite3";`
2. Replace existing SessionManager construction with:

```ts
await migrateJsonToSqliteIfNeeded(botConfigDir, config.tmuxSessionName, config.agentType);
const db = new Database(join(botConfigDir, "bot.sqlite"));
const registry = new SessionRegistry(db);
const router = new HookRouter({
  registry,
  dispatcher: async (windowId, entries) => {
    // Reuse existing runtime.handleNewMessage path
    const { handleNewMessage } = await import("./runtime.js");
    for (const msg of entries) {
      await handleNewMessage(msg, runtimeDeps);
    }
  },
  agentType: config.agentType,
});
```

3. Where SessionMonitor was started — REMOVE that line, do not start it.
4. Add the router to a global lookup map (export from `multiBotRuntime.ts`):

```ts
export const hookRouterRegistry = new Map<string, HookRouter>();
// In bot.start():
hookRouterRegistry.set(config.tmuxSessionName, router);
// In bot.stop():
hookRouterRegistry.delete(config.tmuxSessionName);
db.close();
```

5. After all setup, add startup catch-up:

```ts
for (const s of registry.allLiveSessions()) {
  await drainTranscript(registry, dispatcher, s.session_id);
}
```

(where `dispatcher` is the same one passed to HookRouter; extract it into a const so it can be reused.)

- [ ] **Step 3: Update `runtimeDeps` shape to use Registry instead of SessionManager**

If `runtimeDeps` has a `sessionManager` field, rename or shim it to provide `findUsersForWindow`, `resolveSessionForWindow`, `updateUserWindowOffset` from registry/lookup. Since `runtime.handleNewMessage` and others depend on the old SessionManager API, add a thin compatibility shim:

```ts
// Adapter to bridge old SessionManager API to new Registry
const sessionManagerCompat = {
  findUsersForWindow(windowId: string): Array<[number, string, number]> {
    const result: Array<[number, string, number]> = [];
    for (const [userId, threadId, boundWindowId] of registry.iterThreadBindings()) {
      if (boundWindowId === windowId) result.push([userId, boundWindowId, threadId]);
    }
    return result;
  },
  resolveSessionForWindow: async (windowId: string) => {
    const row = registry.getSessionByWindow(windowId);
    if (!row) return null;
    return { sessionId: row.session_id, summary: "", messageCount: 0, filePath: row.transcript_path, agentType: row.agent_type };
  },
  updateUserWindowOffset: (userId: number, windowId: string, offset: number) => {
    registry.updateUserWindowOffset(userId, windowId, offset);
  },
};
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: 0 errors. (If errors, fix the adapter shape until it satisfies callers.)

- [ ] **Step 5: Run full test suite**

Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: regression tests still PASS; existing tests adjust as needed.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/agent-connect/multiBotRuntime.ts
git commit -m "feat(runtime): wire SessionRegistry + HookRouter into multiBotRuntime"
```

---

### Task 3.5: service.ts — runtime.json lifecycle + tcpProbe + register hook endpoint

**Files:**
- Modify: `apps/bot/src/agent-connect/service.ts`

- [ ] **Step 1: Read current service.ts**

Identify where Fastify is created and where bots are started.

- [ ] **Step 2: Add runtime.json + tcpProbe + endpoint registration**

After config load, before Fastify listen:

```ts
import { writeRuntimeJson, removeRuntimeJson, readRuntimeJson, tcpProbe } from "./runtimeJson.js";
import { agentConnectDir } from "./utils.js";
import { registerHookEndpoint } from "./server.js";
import { hookRouterRegistry } from "./multiBotRuntime.js";

const dir = agentConnectDir(process.env);
const existing = await readRuntimeJson(dir);
if (existing && (await tcpProbe(existing.httpHost, existing.httpPort, 500))) {
  console.error(
    `another agent-connect service is running at ${existing.httpHost}:${existing.httpPort} (pid ${existing.pid})`
  );
  process.exit(1);
}
```

After Fastify is created and routes are registered, but before `await server.listen(...)`:

```ts
registerHookEndpoint(server, (tmuxSession) => hookRouterRegistry.get(tmuxSession) ?? null);
```

After listen succeeds:

```ts
await writeRuntimeJson(dir, {
  httpHost: config.httpHost,
  httpPort: config.httpPort,
  pid: process.pid,
});
```

On shutdown (existing SIGINT/SIGTERM handler):

```ts
await removeRuntimeJson(dir);
```

- [ ] **Step 3: Auto-install hooks on startup**

After bot manager starts, before service finishes startup:

```ts
const { installAllHooks } = await import("./hookInstaller.js");
const result = await installAllHooks();
if (result.code !== 0) console.warn(`Hook install warning: ${result.message}`);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agent-connect/bot typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/agent-connect/service.ts
git commit -m "feat(service): runtime.json lifecycle + tcpProbe + register /hook/events"
```

---

### Task 3.6: bot.ts + runtime.ts + history.ts — rename SessionManager → Registry

**Files:**
- Modify: `apps/bot/src/agent-connect/bot.ts`
- Modify: `apps/bot/src/agent-connect/runtime.ts`
- Modify: `apps/bot/src/agent-connect/history.ts`

- [ ] **Step 1: Find every callsite**

```bash
grep -rn "SessionManager\|sessionManager\." apps/bot/src/agent-connect/bot.ts apps/bot/src/agent-connect/runtime.ts apps/bot/src/agent-connect/history.ts
```

- [ ] **Step 2: Replace systematically**

For each file:
- Replace `import type { SessionManager } from "./session.js"` with `import type { SessionRegistry } from "./sessionRegistry.js"`
- Replace parameter type `SessionManager` with `SessionRegistry`
- Method name mapping (all same in registry):
  - `findUsersForWindow` → use `iterThreadBindings` + filter (already in compat shim from Task 3.4) OR add `findUsersForWindow` method to SessionRegistry
  - `resolveSessionForWindow` → wrap `getSessionByWindow` to return same shape (or add method to Registry)
  - `getDisplayName` → add to Registry: `getDisplayName(windowId: string): string`
  - `updateUserWindowOffset` → same name in Registry
  - `getRecentMessages` → move to `sessionLookup.ts`; call site updated
  - `bindThread` / `unbindThread` / `resolveWindowForThread` / `iterThreadBindings` → same name
  - `resolveChatId` / `setGroupChatId` → same name
  - `getTopicProbeMessageId` / `setTopicProbeMessageId` → same name
  - `listSessionsForDirectory` → call `sessionLookup.listSessionsForDirectory(config, cwd)` instead
  - `sendToWindow` → keep on Registry OR factor into separate `tmuxBridge` module — for now keep on Registry (it just delegates to tmuxManager)
  - `waitForSessionMapEntry` → DELETE the call entirely (hook events arrive via POST, not by file polling); replace with a no-op that returns `true` after a small delay, OR remove the wait entirely from `createAndBindWindow`

- [ ] **Step 3: Add missing methods to SessionRegistry**

Append to `sessionRegistry.ts`:

```ts
getDisplayName(windowId: string): string {
  const row = this.db
    .prepare("SELECT display_name FROM windows WHERE window_id = ?")
    .get(windowId) as { display_name: string } | undefined;
  return row?.display_name ?? windowId;
}

updateDisplayName(windowId: string, newName: string): void {
  this.db
    .prepare("UPDATE windows SET display_name = ? WHERE window_id = ?")
    .run(newName, windowId);
}

findUsersForWindow(windowId: string): Array<[number, string, number]> {
  const rows = this.db
    .prepare("SELECT user_id, thread_id FROM thread_bindings WHERE window_id = ?")
    .all(windowId) as Array<{ user_id: number; thread_id: number }>;
  return rows.map((r) => [r.user_id, windowId, r.thread_id]);
}
```

- [ ] **Step 4: Replace waitForSessionMapEntry in bot.ts**

In `apps/bot/src/agent-connect/bot.ts` `createAndBindWindow`, replace:

```ts
const hookOk = await sessionManager.waitForSessionMapEntry(createdWindowId, resumeSessionId ? 15 : 5);
```

with a poll on `registry.getSessionByWindow`:

```ts
async function waitForRegisteredSession(
  registry: SessionRegistry,
  windowId: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registry.getSessionByWindow(windowId)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const hookOk = await waitForRegisteredSession(registry, createdWindowId, resumeSessionId ? 15000 : 5000);
```

Remove the entire `if (knownSessionId) { ... state.sessionId = knownSessionId; ... }` override block — it is no longer needed because the registry already stores whatever the hook reports, and we trust `transcript_path` regardless of session_id mismatch.

- [ ] **Step 5: Typecheck + test**

Run: `pnpm --filter @agent-connect/bot typecheck`
Run: `pnpm --filter @agent-connect/bot test:ts`

Expected: 0 type errors; regression tests still pass; other tests may need small updates (handled in next task).

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/agent-connect/bot.ts apps/bot/src/agent-connect/runtime.ts apps/bot/src/agent-connect/history.ts apps/bot/src/agent-connect/sessionRegistry.ts
git commit -m "refactor: replace SessionManager calls with SessionRegistry across bot/runtime/history"
```

---

### Task 3.7: Update statusPolling.ts — drop sessionMonitor coupling

**Files:**
- Modify: `apps/bot/src/agent-connect/statusPolling.ts`

- [ ] **Step 1: Review current `statusPolling.ts` deps**

Open the file. Identify any imports from `sessionMonitor` or references to monitor state.

- [ ] **Step 2: Remove monitor-related imports/dependencies**

Keep only:
- TUI status capture via `tmuxManager.capturePane` + `parseStatusLine`
- Topic probe loop
- `messageQueue.enqueueStatusUpdate` + `drain`
- `sessionManager` (now `sessionRegistry`) usage limited to `iterThreadBindings` + `unbindThread` + `findWindowById` cleanup

Replace any `SessionManager` type with `SessionRegistry`. Adjust method calls if any moved.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-connect/bot test:ts -- statusPolling`
Expected: PASS (may need to update mocks).

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/agent-connect/statusPolling.ts apps/bot/tests/statusPolling.test.ts
git commit -m "refactor(status): drop sessionMonitor coupling; use SessionRegistry"
```

---

### Task 3.8: Update server.ts management API to query Registry

**Files:**
- Modify: `apps/bot/src/agent-connect/server.ts`
- Modify: `apps/bot/tests/server.test.ts`

- [ ] **Step 1: Find management routes that read state.json or session_map.json**

```bash
grep -n "state.json\|session_map.json\|stateMap\|sessionMap" apps/bot/src/agent-connect/server.ts
```

- [ ] **Step 2: Replace those reads with Registry queries**

For each endpoint that returned `window_states`, `session_map`, `thread_bindings`, etc., replace the file read with the appropriate `registry.*` call. The response schema for the web frontend stays the same — convert SQLite rows back into the same JSON shape the UI expects.

Reference shape (from `apps/web/src/store.ts`):

```ts
{
  bindings: ThreadBindingEntry[],
  windowStates: WindowStateEntry[],
  userWindowOffsets: UserWindowOffsetEntry[],
  groupChatIds: GroupChatIdEntry[],
  topicProbeMessageIds: TopicProbeMessageIdEntry[],
  displayNames: DisplayNameEntry[],
}
```

Build each from the Registry queries.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-connect/bot test:ts -- server`
Expected: tests pass (update fixtures if needed).

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/agent-connect/server.ts apps/bot/tests/server.test.ts
git commit -m "refactor(server): management API queries SessionRegistry instead of JSON files"
```

---

### Task 3.9: PR-3 close — full sweep + manual smoke

- [ ] **Step 1: Full typecheck + test + build**

Run: `pnpm --filter @agent-connect/bot typecheck`
Run: `pnpm --filter @agent-connect/bot test:ts`
Run: `pnpm --filter @agent-connect/bot build`
Expected: all green.

- [ ] **Step 2: Manual smoke**

Start the service: `pnpm dev`

In Telegram (with bot 1 / cc-dog):
- New topic, choose project directory (fresh session, no resume)
- Send "hello"
- Verify: assistant reply arrives in Telegram (not stuck on "Thinking…")
- Send another message — verify reply arrives
- In Claude tmux window: type `/clear` and confirm
- Send "hello again" in Telegram — verify reply arrives
- Pick "resume an existing session" path: new topic, select directory with existing sessions, pick one
- Send a message, verify reply arrives

If anything fails, do not proceed to PR-4. Diagnose with `console.warn` lines in `hookRouter` + `drainTranscript` (or `DEBUG=agc:*` if configured).

- [ ] **Step 3: Push PR-3**

```bash
git push
gh pr create --title "PR-3: Cutover — replace SessionMonitor with HookRouter" --body "$(cat <<'EOF'
## Summary
- Replace SessionMonitor polling with HookRouter event dispatch in multiBotRuntime
- Wire Fastify /hook/events endpoint
- service.ts manages runtime.json + tcpProbe single-instance check + auto-install hooks
- bot.ts/runtime.ts/history.ts use SessionRegistry instead of SessionManager
- statusPolling slimmed (no monitor coupling)
- server.ts management API queries Registry

## Regression coverage
- `regression-first-response-race.test.ts` — fast assistant reply not lost
- `regression-resume-session-mismatch.test.ts` — bot follows transcript_path, not session_id ↔ filename

## Test plan
- [x] All tests green
- [x] Manual smoke: new session, /clear, resume — all deliver assistant text

## Note
Old code still present (sessionMonitor.ts / monitorState.ts / session.ts / hook.ts) — to be removed in PR-4.
EOF
)"
```

---

# PR-4: Delete Dead Code

Pure deletion. No behavior change. Should be a quick PR.

---

### Task 4.1: Delete `sessionMonitor.ts` + tests

- [ ] **Step 1: Remove the files**

```bash
git rm apps/bot/src/agent-connect/sessionMonitor.ts
git rm apps/bot/src/agent-connect/monitorState.ts
git rm -f apps/bot/tests/sessionMonitor.test.ts apps/bot/tests/monitorState.test.ts
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -rn "sessionMonitor\|SessionMonitor\|monitorState\|MonitorState\|TrackedSession" apps/bot/src/agent-connect/
```

Expected: no matches.

- [ ] **Step 3: Typecheck + test**

Run: `pnpm --filter @agent-connect/bot typecheck`
Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete sessionMonitor + monitorState (replaced by HookRouter)"
```

---

### Task 4.2: Delete `session.ts` (state side migrated to Registry, lookups extracted)

- [ ] **Step 1: Verify no remaining imports of `session.js`**

```bash
grep -rn "from \"\.\/session\.js\"\|from \"\.\.\/agent-connect/session" apps/bot/src apps/bot/tests
```

Expected: no matches. If any remain, finish migration first.

- [ ] **Step 2: Remove file**

```bash
git rm apps/bot/src/agent-connect/session.ts
git rm -f apps/bot/tests/session.test.ts
```

- [ ] **Step 3: Typecheck + test**

Run: `pnpm --filter @agent-connect/bot typecheck`
Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete session.ts (split into sessionRegistry + sessionLookup)"
```

---

### Task 4.3: Delete old `hook.ts` (split into hookInstaller + hookClient)

- [ ] **Step 1: Update CLI entry to use new modules**

In `packages/cli/src/index.ts`, change:

```ts
const { hookMain } = await import("@agent-connect/bot/hook");
```

to:

```ts
const { runHookClient } = await import("@agent-connect/bot/hookClient");
const { installAllHooks } = await import("@agent-connect/bot/hookInstaller");
```

And update the `hook` subcommand dispatcher to call `runHookClient` for the stdin path and `installAllHooks` for `--install`.

Update `apps/bot/package.json` `exports` to add:

```json
"./hookClient": {
  "types": "./dist/src/agent-connect/hookClient.d.ts",
  "default": "./dist/src/agent-connect/hookClient.js"
},
"./hookInstaller": {
  "types": "./dist/src/agent-connect/hookInstaller.d.ts",
  "default": "./dist/src/agent-connect/hookInstaller.js"
}
```

And remove the existing `"./hook"` export.

- [ ] **Step 2: Remove file**

```bash
git rm apps/bot/src/agent-connect/hook.ts
git rm -f apps/bot/tests/hook.test.ts
```

- [ ] **Step 3: Typecheck + build + test**

Run: `pnpm --filter @agent-connect/bot typecheck`
Run: `pnpm --filter @agent-connect/bot build`
Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/index.ts apps/bot/package.json
git commit -m "chore: delete hook.ts (split into hookClient + hookInstaller)"
```

---

### Task 4.4: Slim `codexSessions.ts` (remove cwd scan helpers)

- [ ] **Step 1: Identify what is still used**

```bash
grep -rn "scanCodexSessionsForCwds\|findCodexSessionInfo" apps/bot/src apps/bot/tests
```

Expected: no callers besides codexSessions itself.

- [ ] **Step 2: Delete the unused functions**

In `apps/bot/src/agent-connect/codexSessions.ts`, delete:
- `scanCodexSessionsForCwds`
- `findCodexSessionInfo` (if unused)
- helpers used only by those functions

Keep:
- `findCodexSession` (used by sessionLookup)
- `listCodexSessionsForDirectory` (used by sessionLookup)

- [ ] **Step 3: Typecheck + test**

Run: `pnpm --filter @agent-connect/bot typecheck`
Run: `pnpm --filter @agent-connect/bot test:ts`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/agent-connect/codexSessions.ts
git commit -m "chore: drop scanCodexSessionsForCwds (runtime data path no longer scans)"
```

---

### Task 4.5: PR-4 close

- [ ] **Step 1: Push PR-4**

```bash
git push
gh pr create --title "PR-4: Delete sessionMonitor + session.ts + hook.ts dead code" --body "$(cat <<'EOF'
## Summary
- Delete `sessionMonitor.ts`, `monitorState.ts`, `session.ts`, `hook.ts` (and tests)
- Slim `codexSessions.ts` (drop cwd-scan functions)
- Update CLI dispatcher to use `hookClient` + `hookInstaller`

## Test plan
- [x] Tests green
- [x] Build green
- [x] No regressions in manual smoke
EOF
)"
```

---

# PR-5: Docs Cleanup

---

### Task 5.1: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Edit the architecture section**

Replace the "Core Design Constraints" line about `Hook-based session tracking` with:

```
- **Hook-driven runtime** — Claude and Codex hooks POST events to the bot's `/hook/events` endpoint; bot keeps state in per-bot `bot.sqlite`.
- **Session-window mapping in SQLite** — `sessions` and `windows` tables replace `session_map.json` + `state.json`; `windows`-deletion CASCADES via FK to sessions/bindings.
```

Delete the line about `session_map.json` and `monitor watches that map`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): describe hook-driven runtime + SQLite"
```

---

### Task 5.2: Update `.claude/rules/architecture.md`

**Files:**
- Modify: `.claude/rules/architecture.md`

- [ ] **Step 1: Rewrite the architecture diagram**

Replace the existing diagram with:

```text
Telegram Forum Topic
  -> thread_bindings (SQLite)
  -> tmux window ID
  -> Claude/Codex session
  -> hook -> POST /hook/events
  -> HookRouter (per-window queue)
  -> drainTranscript (per-session lock)
  -> Telegram message queue
```

Replace the "State" section:

```
Default config root is `$AGENT_CONNECT_DIR`, usually `~/.agent-connect`.

- `agent-connect.sqlite` stores bot configs.
- `bots/<id>/bot.sqlite` stores per-bot runtime state (windows, sessions, thread_bindings, user_window_offsets).
- `runtime.json` holds the running service's `{httpHost, httpPort, pid}` for hook clients to find.
```

Update module inventory: remove `sessionMonitor.ts`, `monitorState.ts`, `session.ts`, old `hook.ts`. Add: `sessionRegistry.ts`, `sessionLookup.ts`, `hookRouter.ts`, `hookClient.ts`, `hookInstaller.ts`, `drainTranscript.ts`, `migration.ts`, `runtimeJson.ts`.

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/architecture.md
git commit -m "docs(architecture): replace SessionMonitor/JSON state with HookRouter/SQLite"
```

---

### Task 5.3: Update `.claude/rules/topic-architecture.md`

**Files:**
- Modify: `.claude/rules/topic-architecture.md`

- [ ] **Step 1: Replace "Mapping 2" section**

Old text used `session_map.json`. Replace with:

```
## Mapping 2: Window ID → Session (SQLite `sessions` table)

```sql
-- one live session per window enforced by UNIQUE INDEX
SELECT session_id, transcript_path FROM sessions WHERE window_id = ?;
```

- Storage: `bots/<id>/bot.sqlite`
- Written when: `SessionStart` hook fires (POST `/hook/events` → DELETE+INSERT in a transaction)
- Purpose: HookRouter routes transcript reads to the right file; `drainTranscript` advances `last_byte_offset`
```

- [ ] **Step 2: Remove the `--resume` "override" note**

Delete the entire paragraph about `--resume` overriding `state.sessionId`. Replace with:

```
**Resume note**: When `claude --resume X` causes the hook to report a session id different from the file name (rare but observed), the bot follows the `transcript_path` from the hook payload — there is no longer any session-id-based filename lookup, so no override is needed.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/topic-architecture.md
git commit -m "docs(topic): SQLite sessions table; remove obsolete resume override note"
```

---

### Task 5.4: Update `.claude/rules/message-handling.md`

**Files:**
- Modify: `.claude/rules/message-handling.md`

- [ ] **Step 1: Replace "Performance Optimizations" section**

The old text described mtime caching and byte offset polling. Replace with:

```
## Performance characteristics

**Event-driven, not polled.** Hook events trigger `drainTranscript` which reads only new bytes since the recorded `last_byte_offset` for that session. No file watching, no mtime caching, no scanning needed.

**Per-session serialization.** `SessionRegistry.withSessionLock` ensures only one drain per session at a time; concurrent events queue. Different sessions drain in parallel.

**Per-window event ordering.** `HookRouter` maintains a `Map<windowId, Promise>` queue so `SessionStart` always completes before any subsequent event for the same window.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/message-handling.md
git commit -m "docs(message): describe hook-driven event ordering + per-session lock"
```

---

### Task 5.5: PR-5 close

- [ ] **Step 1: Push PR-5**

```bash
git push
gh pr create --title "PR-5: Docs cleanup for hook-driven runtime" --body "$(cat <<'EOF'
## Summary
- Update CLAUDE.md, .claude/rules/architecture.md, topic-architecture.md, message-handling.md
- Remove references to sessionMonitor / session_map.json / monitor polling
- Document HookRouter + SessionRegistry + per-session lock
EOF
)"
```

---

## Done Definition

All five PRs merged. On `main`:

1. `pnpm test:ts` green (includes both regression tests)
2. `pnpm typecheck` green
3. `pnpm build` green
4. `apps/bot/src/agent-connect/` contains no references to `SessionMonitor` or `session_map.json`
5. Manual smoke test in Telegram confirms:
   - Fresh new session → reply arrives
   - `/clear` then new prompt → reply arrives
   - Resume existing session → reply arrives
   - Multiple topics in one bot, simultaneous activity → no cross-talk, no missed messages
