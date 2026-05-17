# Hook-Driven Runtime Design

**Date:** 2026-05-17
**Status:** Draft (pending user review)
**Scope:** Refactor agent-connect's session tracking from file-tail polling to hook-driven push, backed by SQLite. Both Claude and Codex.

---

## 0. Problem Statement

### 0.1 Symptom

In Telegram, users sometimes never receive Claude's final answer. The "Thinking…" status keeps updating, but the assistant text never arrives.

### 0.2 Root Cause

`apps/bot/src/agent-connect/sessionMonitor.ts:226-231`:

```ts
if (!tracked) {
  tracked = new TrackedSession(sessionInfo.sessionId, sessionInfo.filePath, fileStat.size);
  this.state.updateSession(tracked);
  this.fileMtimes[sessionInfo.sessionId] = fileStat.mtimeMs;
  continue;  // ← captures offset at EOF and skips delivery
}
```

When SessionMonitor first detects a new session, it sets `lastByteOffset` to the current file size and skips delivery. Any content already in the file (including the first assistant response, if Claude is fast) is permanently lost.

The "Thinking…" the user sees comes from `statusPolling` reading the tmux pane every 1s independently — it keeps ticking even when the jsonl reader has dropped content.

### 0.3 Secondary Architectural Pain

The file-based tracking carries a constellation of state that has to stay synchronized:

- `session_map.json` (written by Claude/Codex `SessionStart` hook)
- `state.json` (`window_states`, `thread_bindings`, `user_window_offsets`, `window_display_names`, `group_chat_ids`, `topic_probe_message_ids`)
- `monitor_state.json` (`tracked_sessions` with byte offsets)
- in-memory caches (`fileMtimes`, `pendingTools`, `lastSessionMap`)

When these drift, behavior breaks in non-obvious ways. The user's bot 1 currently has:

- `session_map.json`: `@2 → 019e35c4-...` (file does not exist on disk)
- `state.json`: `@2 → 5ffbc75b-...` (file exists, last written 19:49)
- `~/.claude/projects/.../d8d7ff50-...jsonl`: actively written 20:06 (not in either map)

The `topic-architecture.md` "resume override" workaround acknowledges this fragility:
> `--resume` makes the hook report a new session_id but messages continue writing to the original JSONL file; the bot overrides window_state to track the original session_id.

But the override only updates `state.sessionId` — `SessionMonitor.loadCurrentSessionMap()` reads `session_map.json` directly and ignores it. So the override is dead code for the monitor; the bug is structural.

### 0.4 Decision

Refactor to a hook-driven runtime. The hook tells us exactly which session changed and where its transcript lives, removing the polling race, the cwd-matching scan, the session-id ↔ filename guesswork, and the multi-file state synchronization.

---

## 1. Architecture

```
Claude/Codex CLI
   │
   │ (hook event JSON via stdin)
   ▼
agc hook  ────POST────►  Fastify /hook/events  ──►  HookRouter
                                                       │
                          ┌────────────────────────────┼────────────────────────────┐
                          ▼                            ▼                            ▼
                  SessionRegistry            drainTranscript                TelegramDispatcher
                  (SQLite-backed:            (read jsonl from              (existing
                   bindings, sessions,        last_byte_offset to EOF       MessageQueueManager
                   offsets)                   inside per-session lock)      + runtime.handleNewMessage)

                          ▲
                          │ (1Hz, tmux capture only)
                  StatusPoller  ───►  TelegramDispatcher (status text only)
```

### 1.1 Components

| Component | Responsibility |
|---|---|
| `agc hook` (CLI) | Read stdin payload; resolve tmux session/window/name; POST to `/hook/events`; `exit 0` regardless. |
| Fastify `/hook/events` | Accept envelope; respond `202` immediately via `setImmediate`; never block hook process. |
| `HookRouter` (per-bot) | Dispatch envelope by `hook_event_name`; serialize per-window via `Map<windowId, Promise>` queue. |
| `SessionRegistry` (per-bot) | Sole holder of runtime state. SQLite-backed. Exposes domain API; no SQL leaks out. |
| `drainTranscript` | Read jsonl from `last_byte_offset` to EOF inside per-session lock; parse via existing `TranscriptParser`; advance offset; dispatch. |
| `TelegramDispatcher` | Existing `MessageQueueManager` + `runtime.handleNewMessage`. Unchanged. |
| `StatusPoller` | Slimmed: only tmux pane → TUI status line + topic-probe (60s). No coupling to monitor/session reads. |

### 1.2 Removed Concepts

- Polling loop (`sessionMonitor.tick`)
- `session_map.json` (hook payload carries `session_id` + `transcript_path` directly)
- `scanProjects` / `scanCodexProjects` / cwd matching (hook tells us the file)
- `fileMtimes` cache, `lastSessionMap` diff (no polling, no need)
- `state.json` (replaced by SQLite)
- `monitor_state.json` (replaced by SQLite)
- Hook-side lock files for `session_map.json` (single bot process owns SQLite)

---

## 2. SQLite Schema

Per-bot database at `$AGENT_CONNECT_DIR/bots/<id>/bot.sqlite`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Currently live tmux windows. Row deleted when tmux window dies.
-- Replaces state.json.window_display_names.
CREATE TABLE windows (
  window_id    TEXT PRIMARY KEY,    -- "@0", "@12"
  display_name TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  created_at   INTEGER NOT NULL     -- unix ms
);

-- Live sessions only (no history). One live session per window enforced by UNIQUE.
-- Replaces session_map.json + state.json.window_states + monitor_state.json.tracked_sessions.
CREATE TABLE sessions (
  session_id       TEXT PRIMARY KEY,    -- hook payload session_id (UUID)
  window_id        TEXT NOT NULL,
  agent_type       TEXT NOT NULL,       -- 'claude' | 'codex'
  transcript_path  TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  source           TEXT,                -- startup|resume|clear|compact
  last_byte_offset INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_sessions_window ON sessions(window_id);

-- Telegram topic ↔ tmux window. Replaces thread_bindings + group_chat_ids + topic_probe_message_ids.
CREATE TABLE thread_bindings (
  user_id                INTEGER NOT NULL,
  thread_id              INTEGER NOT NULL,
  window_id              TEXT NOT NULL,
  group_chat_id          INTEGER,
  topic_probe_message_id INTEGER,
  bound_at               INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
CREATE INDEX idx_bindings_window ON thread_bindings(window_id);

-- /history pagination cursor per user per window. Replaces state.json.user_window_offsets.
CREATE TABLE user_window_offsets (
  user_id     INTEGER NOT NULL,
  window_id   TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
```

### 2.1 Schema Notes

- `sessions.window_id` has FK CASCADE to `windows`. Killing a tmux window cascades to sessions, thread_bindings, user_window_offsets.
- `UNIQUE INDEX idx_sessions_window` enforces 1 window = 1 live session. `SessionStart` for any source runs in a transaction:
  ```sql
  BEGIN;
    DELETE FROM sessions WHERE window_id = ?;
    INSERT INTO sessions (...) VALUES (...);
  COMMIT;
  ```
- `sessions.last_byte_offset` (bot-delivered position) and `user_window_offsets.byte_offset` (user-read position) are intentionally separate concerns, separate tables.
- No `events` / journal table — per the reliability decision, lost events stay lost; catch-up rebuilds assistant text only.

### 2.2 SessionRegistry API

```ts
class SessionRegistry {
  // windows
  upsertWindow(windowId: string, displayName: string, cwd: string): void;
  deleteWindow(windowId: string): void;  // CASCADE deletes sessions + bindings + offsets
  listLiveWindows(): WindowRow[];

  // sessions
  registerSession(args: {
    sessionId: string; windowId: string; agentType: 'claude' | 'codex';
    transcriptPath: string; cwd: string; source?: string;
  }): void;
  endSession(sessionId: string): void;
  getSession(sessionId: string): SessionRow | null;
  getSessionByWindow(windowId: string): SessionRow | null;
  allLiveSessions(): SessionRow[];

  // per-session serialization for transcript reads
  withSessionLock<T>(sessionId: string, fn: (session: SessionRow) => Promise<T>): Promise<T>;
  setOffset(sessionId: string, offset: number): void;  // call inside lock only

  // bindings
  bindThread(userId: number, threadId: number, windowId: string): void;
  unbindThread(userId: number, threadId: number): string | null;
  resolveWindowForThread(userId: number, threadId: number): string | null;
  iterThreadBindings(): IterableIterator<[number, number, string]>;
  setGroupChatId(userId: number, threadId: number, chatId: number): void;
  resolveChatId(userId: number, threadId: number | null): number;
  setTopicProbeMessageId(userId: number, threadId: number, messageId: number): void;
  getTopicProbeMessageId(userId: number, threadId: number): number | null;

  // user history pagination
  updateUserWindowOffset(userId: number, windowId: string, offset: number): void;
  getUserWindowOffset(userId: number, windowId: string): number | null;
}
```

---

## 3. Hook Event Handling

### 3.1 `agc hook` (slimmed)

```
1. Read stdin → parse Claude/Codex payload JSON
2. tmux display-message -t $TMUX_PANE -p '#{session_name}:#{window_id}:#{window_name}'
3. Read $AGENT_CONNECT_DIR/runtime.json → {httpHost, httpPort}
4. POST http://host:port/hook/events  body:
     { tmux_session, window_id, window_name, payload: <original hook payload> }
   timeout 2s
5. exit 0 regardless (never block Claude)
```

### 3.2 Fastify endpoint

```ts
fastify.post('/hook/events', async (req, reply) => {
  setImmediate(() => hookRouter.dispatch(req.body).catch(logHookError));
  return reply.code(202).send();
});
```

`202` returns before processing starts. Hook's 5s timeout will never be approached.

### 3.3 `drainTranscript(sessionId)` — single jsonl entry point

```ts
async function drainTranscript(registry, dispatcher, sessionId) {
  return registry.withSessionLock(sessionId, async (session) => {
    if (!session.transcript_path) return;
    const stat = await statOrNull(session.transcript_path);
    if (!stat) return;
    let startOffset = session.last_byte_offset;
    if (stat.size < startOffset) {
      // file truncated externally (rare) — re-read from beginning
      registry.setOffset(sessionId, 0);
      pendingTools.delete(sessionId);
      startOffset = 0;
    }
    if (stat.size <= startOffset) return;
    const buf = await readBytes(session.transcript_path, startOffset, stat.size);
    const carry = pendingTools.get(sessionId) ?? {};
    const [entries, remaining] = TranscriptParser.parseEntries(parseLines(buf), carry);
    if (Object.keys(remaining).length > 0) pendingTools.set(sessionId, remaining);
    else pendingTools.delete(sessionId);
    registry.setOffset(sessionId, stat.size);
    await dispatcher(session.window_id, entries);  // → runtime.handleNewMessage
  });
}
```

`pendingTools` is in-memory `Map<sessionId, PendingToolInfo>` (lost on restart, rebuilt on next drain — acceptable).

### 3.4 Event dispatch table

| Event | Action | Notes |
|---|---|---|
| `SessionStart` | `upsertWindow` + transactional DELETE+INSERT into `sessions` | No Telegram dispatch |
| `SessionEnd` | `drainTranscript` then `DELETE FROM sessions WHERE session_id` | Claude only; Codex has no SessionEnd |
| `UserPromptSubmit` | `drainTranscript` | User echo controlled by existing `showUserMessages` |
| `PreToolUse` | Render `"Using **<tool>**(...)"` status via existing `formatToolUseSummary` | No jsonl read |
| `PostToolUse` | `drainTranscript` | jsonl has both tool_use and tool_result; existing runtime logic intact |
| `PostToolBatch` | `drainTranscript` | Claude only |
| `PostToolUseFailure` | `drainTranscript` | Claude only |
| `Stop` | `drainTranscript` | Assistant text lives here for both Claude and Codex |
| `Notification` | Render `message` to status | Claude only |
| `PermissionRequest` | Status message indicating approval needed | Codex only |
| Other events | Ignored | Add as needed |

### 3.5 Codex specifics

- 6 events instead of 29; subset of Claude's.
- `Stop.last_assistant_message` is **ignored**. All assistant text flows through `drainTranscript` → `TranscriptParser.parseCodexEntry` for one unified path.
- `transcript_path` may be `null` early in session lifetime; `drainTranscript` handles that as no-op.
- No `SessionEnd` — session row cleanup relies on:
  1. New `SessionStart` overwriting (most common)
  2. tmux window death → FK CASCADE
- `~/.codex/config.toml` `[features] hooks = true` toggled by existing `syncCodexHooksFeatureFlag`.
- Agent type comes from bot config (`agentType`), not payload sniffing.

### 3.6 Startup catch-up

```ts
async onStartup() {
  await reconcileLiveWindows();    // tmux list ↔ windows table; delete dead
  for (const s of registry.allLiveSessions()) {
    await drainTranscript(s.session_id);  // catches missed assistant text
  }
}
```

Lost intermediate state (tool progress, status updates) during downtime is not recovered, per design.

---

## 4. Lifecycle

### 4.1 One-shot JSON → SQLite migration

```
if (!exists(bots/<id>/bot.sqlite)) {
  createSchema(bots/<id>/bot.sqlite);
  if (any of state.json, session_map.json, monitor_state.json exists) {
    BEGIN TRANSACTION;
      // windows: merge window_display_names + cwd from window_states or session_map
      // sessions: session_map is authoritative; offsets from monitor_state.tracked_sessions
      // thread_bindings: merge with group_chat_ids + topic_probe_message_ids
      // user_window_offsets: copy as-is
      writeMeta('schema_version', '1');
      writeMeta('migrated_from_json_at', now);
    COMMIT;
    rename state.json         → state.json.migrated-YYYY-MM-DD
    rename session_map.json   → session_map.json.migrated-YYYY-MM-DD
    rename monitor_state.json → monitor_state.json.migrated-YYYY-MM-DD
  }
}
```

Rollback path: `mv state.json.migrated state.json && rm bot.sqlite`.

### 4.2 Startup sequence

```
service.ts main:
  config = loadConfig()
  if exists(runtime.json) and tcpProbe(httpPort) succeeds:
    abort: "another agent-connect service is running at <port>"
  writeRuntimeJson({ httpHost, httpPort })
  fastify = Fastify()
  fastify.post('/hook/events', ...)
  fastify.<existing management routes>
  await fastify.listen(httpHost, httpPort)
  await ensureHooksInstalled()  // Claude + Codex settings sync
  multiBotManager.start():
    for each bot:
      migrateJsonToSqliteIfNeeded(bot)
      registry = new SessionRegistry(bot.sqlite)
      router = new HookRouter(registry, dispatcher)
      registerRouterByTmuxSession(bot.tmuxSessionName, router)
      await reconcileLiveWindows(registry, tmuxManager)
      for (s of registry.allLiveSessions()) await drainTranscript(s.session_id)
      statusPoller.start()
      grammyBot.start()
```

### 4.3 Shutdown

```
on SIGINT/SIGTERM:
  for each bot:
    grammyBot.stop()
    statusPoller.stop()
    await drainInFlightHookEvents()  // small grace window
    registry.close()                  // SQLite
  fastify.close()
  removeRuntimeJson()
```

### 4.4 Hook installer changes

`syncHookSettings(settings, hookCommand, events: string[])` becomes the unified entry. Claude installs 9 events:

```
SessionStart  (matcher: "startup|resume|clear|compact")
SessionEnd
UserPromptSubmit
PreToolUse
PostToolUse
PostToolBatch
PostToolUseFailure
Stop
Notification
```

Codex installs 6 events:

```
SessionStart  (matcher: "startup|resume|clear")
UserPromptSubmit
PreToolUse
PermissionRequest
PostToolUse
Stop
```

Codex `~/.codex/config.toml` `[features] hooks = true` set by `syncCodexHooksFeatureFlag` (existing).

Auto-install runs at bot startup via `ensureHooksInstalled()`. Manual run available as `agc hook --install`. Both idempotent.

### 4.5 Hook process overhead

Each tool call fires Pre + Post hooks; Stop fires per turn. With Node cold start ~50ms, ~4 hooks × 50ms ≈ 200ms per turn of added latency. Acceptable for v1.

v2 optimization (only if needed): replace `agc hook` entrypoint with a tiny `hook-shim.cjs` requiring only `node:http` and `node:child_process` — should drop to ~20ms cold start.

---

## 5. Failure Modes

### 5.1 Lifecycle

| Situation | Handling |
|---|---|
| User closes Telegram topic | Existing `topicClosedHandler` → `registry.unbindThread` |
| `tmux kill-window @N` | StatusPoller diff detects → `registry.deleteWindow(@N)` → FK CASCADE clears sessions/bindings/offsets |
| `tmux kill-session` | Same as above, batched |
| Claude crashes, tmux survives | Detected on next `SessionStart`; transactional overwrite |
| `/clear` or resume | SessionStart fires; DELETE+INSERT in transaction; no overrides needed |

### 5.2 Data integrity

| Situation | Handling |
|---|---|
| jsonl file deleted externally | `statOrNull` returns null → event no-op |
| jsonl corrupt line | Existing `parseLine` returns null, `readNewLines` `break` on non-empty unparseable, skip empty lines |
| jsonl truncated (size < offset) | Reset offset to 0 inside drainTranscript |
| Migration mid-failure | Wrapped in single SQLite transaction; rollback drops partial DB; JSON files renamed last (still in original location) |

### 5.3 Communication

| Situation | Handling |
|---|---|
| `agc hook` can't find runtime.json | Bot not running. Hook silent exit 0. Catch-up on startup recovers assistant text. |
| `agc hook` POST fails (refused / timeout) | 2s timeout, stderr suppressed, exit 0. |
| Fastify endpoint throws | setImmediate isolates; logged via `console.warn`; 202 already returned. |
| Bot offline for events | Startup catch-up restores assistant text; intermediate progress lost (by design). |
| Stale runtime.json (port changed) | Hook POST refused → silent exit; next bot startup overwrites. |

### 5.4 Single-process exclusion

Service startup probes existing `runtime.json`:

```ts
if (exists(runtime.json) && await tcpProbe(host, port)) {
  abort('another agent-connect service is running at <port>');
}
```

Prevents two services racing on one SQLite.

### 5.5 Event ordering

SessionStart and subsequent events come from different `agc hook` processes and may arrive at Fastify out of order. `HookRouter` enforces per-window serialization:

```ts
async dispatch(envelope) {
  const key = envelope.window_id;
  const prev = this.queues.get(key) ?? Promise.resolve();
  const next = prev.then(() => this.handleOne(envelope)).catch(logHookError);
  this.queues.set(key, next);
  next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  return next;
}
```

Same window → strictly serial. Different windows → parallel.

Per-session lock (Section 3.3) handles same-session intra-write races; per-window queue handles session-switch transitions.

Fallback: if `drainTranscript` finds no session row, log warn and silently drop.

### 5.6 Capacity

| Situation | Handling |
|---|---|
| Large drainTranscript (multi-MB after long downtime) | Buffer read; TranscriptParser streams lines; OK up to tens of MB |
| Frequent hook bursts | Per-window queue throttles; IO bound on jsonl reads |
| Table growth | "Live only" + FK CASCADE prevents unbounded growth |
| `pendingTools` memory | Same lifetime as session row; evicted with `endSession` |

### 5.7 Explicitly NOT addressed

1. Lost Telegram inbound messages when bot is down — that's grammy's responsibility, out of scope.
2. Cross-host deployment — runtime.json + 127.0.0.1 assumes single host.
3. Multi-tenant multi-service on same host — blocked by 5.4 port probe.
4. Hook process OOM kill — intermediate events lost, catch-up restores text.

---

## 6. Testing

### 6.1 Regression tests (gating)

#### `apps/bot/tests/regression-first-response-race.test.ts`

```ts
test('fast assistant reply within 2s of SessionStart is not lost', async () => {
  const { registry, hookRouter, dispatched } = await setupBot();
  const transcript = await writeFakeTranscript([
    { type: 'user',      message: { content: 'hello' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
  ]);
  await hookRouter.dispatch(envelope('SessionStart', { transcript_path: transcript }));
  await hookRouter.dispatch(envelope('Stop', { session_id: 'X', transcript_path: transcript }));
  expect(dispatched).toContainEqual(expect.objectContaining({
    role: 'assistant', text: 'Hi!', contentType: 'text'
  }));
});
```

#### `apps/bot/tests/regression-resume-session-mismatch.test.ts`

```ts
test('resume: hook reports different session_id than the transcript filename', async () => {
  const { registry, hookRouter, dispatched } = await setupBot();
  const transcriptX = await writeFakeTranscript([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'prior turn' }] } },
  ], { sessionId: 'X' });
  await hookRouter.dispatch(envelope('SessionStart', {
    session_id: 'Y',
    transcript_path: transcriptX,
    source: 'resume',
  }));
  await appendToTranscript(transcriptX, [
    { type: 'user',      message: { content: 'hi again' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'resumed reply' }] } },
  ]);
  await hookRouter.dispatch(envelope('Stop', { session_id: 'Y', transcript_path: transcriptX }));
  expect(dispatched).toContainEqual(expect.objectContaining({
    text: 'resumed reply', role: 'assistant', contentType: 'text'
  }));
  const row = registry.getSessionByWindow('@0');
  expect(row.session_id).toBe('Y');
  expect(row.transcript_path).toBe(transcriptX);
});
```

Both must fail on `main` before refactor and pass after. PR-3 merge blocked otherwise.

### 6.2 Unit test matrix

| File (new) | Scope | Key cases |
|---|---|---|
| `sessionRegistry.test.ts` | SQLite CRUD | upsert/delete + FK CASCADE; registerSession DELETE+INSERT idempotency; offset rewind on truncation |
| `sessionRegistry-lock.test.ts` | per-session serialization | 100 concurrent `withSessionLock` complete with no reentry; different sids run in parallel; lock released on throw |
| `hookRouter.test.ts` | dispatch + per-window queue | SessionStart processes before out-of-order PostToolUse; unknown event no-throw; missing bot no-throw |
| `drainTranscript.test.ts` | jsonl reader | empty no-op; new content dispatched + offset advanced; truncation reset; partial trailing line; pendingTools carry |
| `hookServer.test.ts` | Fastify integration | POST returns 202 fast; body validation; async processing; endpoint error isolation |
| `migration.test.ts` | JSON → SQLite | fixture round-trip; idempotent re-run; corrupt JSON aborts cleanly; stale window skipped |
| `hookInstaller.test.ts` (update) | settings sync | install 9 Claude / 6 Codex events; idempotent; preserves user's non-agc hooks; feature flag toggle |

### 6.3 Unchanged tests

`messageQueue` / `transcriptParser` / `tmuxManager` / `runtime` — these modules don't change.

### 6.4 Updated tests

`statusPolling.test.ts` (drop monitor coupling), `server.test.ts` (queries Registry), `bot.test.ts` (Registry rename).

### 6.5 Deleted tests

`sessionMonitor.test.ts`, `monitorState.test.ts` (if present), JSON-persistence portions of `session.test.ts`.

### 6.6 Test infrastructure

- SQLite: `:memory:` for all Registry tests
- jsonl: real tmp files (no fs mock)
- Fastify: `fastify.inject(...)` — no port binding
- Telegram dispatch: fake function recording `(windowId, NewMessage[])`
- Tmux: mock `listWindows` / `findWindowById`

### 6.7 Gating

PR-3 merge requires:

1. `pnpm test:ts` all green
2. `pnpm typecheck` all green
3. `pnpm build` all green
4. Both regression tests in 6.1 fail when reverted to main (proves they cover the actual bugs)
5. Manual smoke: new topic → Claude reply → received; `/clear` → reply → received; resume existing session → reply → received

### 6.8 Not tested

- Hook process cold-start latency (environmental)
- End-to-end with real Claude (manual smoke only)
- Cross-process SQLite contention (architecturally prevented)
- Hook POST retry logic (not in design)

---

## 7. Implementation Manifest

### 7.1 File changes

**Delete:**

```
apps/bot/src/agent-connect/sessionMonitor.ts          (-524)
apps/bot/src/agent-connect/monitorState.ts            (-103)
apps/bot/tests/sessionMonitor.test.ts                 (-?)
apps/bot/tests/monitorState.test.ts                   (if present)
```

**Split:**

```
session.ts (-680)
  ├─→ sessionRegistry.ts        [+~350]  state, SQLite-backed
  └─→ sessionLookup.ts          [+~180]  read-only jsonl ops for /history

hook.ts (-562)
  ├─→ hookInstaller.ts          [+~250]  install + settings sync
  └─→ hookClient.ts             [+~80]   agc hook CLI stdin → POST
```

**New:**

```
hookRouter.ts        [+~200]  dispatch + per-window queue + handlers
migration.ts         [+~150]  JSON → SQLite one-shot
runtimeJson.ts       [+~40]   write/read/remove + tcpProbe
hookTypes.ts         [+~60]   shared envelope/payload types
drainTranscript.ts   [+~80]   single jsonl entry point
```

**Modify:**

```
multiBotRuntime.ts        [~120 diff]  drop SessionMonitor; wire HookRouter
server.ts                 [~80 diff]   add /hook/events; management API queries Registry
service.ts                [~30 diff]   runtime.json lifecycle; tcpProbe; ensureHooksInstalled
statusPolling.ts          [~50 diff]   slim: TUI status + topic probe only
bot.ts                    [~40 diff]   SessionManager → SessionRegistry rename
runtime.ts                [~10 diff]   SessionRegistry rename
codexSessions.ts          [~80 diff]   delete scanCodexSessionsForCwds; keep history funcs
history.ts                [~20 diff]   take Registry instead of SessionManager
```

**Unchanged (22 files):** `bashCapture.ts botConfig.ts callbackData.ts claudeCommand.ts config.ts configStore.ts directoryBrowser.ts interactiveUi.ts main.ts markdownV2.ts messageQueue.ts messageSender.ts proxy.ts responseBuilder.ts screenshot.ts telegramClient.ts telegramSender.ts telegramThread.ts terminalParser.ts tmuxManager.ts transcribe.ts transcriptParser.ts utils.ts`

### 7.2 Net effect

- ~1900 lines deleted, ~1300 lines added → net code reduction
- Complexity reduction much larger than line count suggests (no polling, no mtime cache, no cross-process file locks, no cwd-matching, no session_id ↔ filename guesswork, no `state.sessionId` override)
- `TranscriptParser` completely untouched — content rendering preserved; only delivery trigger changes

### 7.3 PR sequence

Five independently mergeable PRs:

1. **PR-1 Infrastructure** — sessionRegistry + sessionRegistry-lock test + migration + migration test + runtimeJson. Pure additions.
2. **PR-2 Hook plumbing** — hookTypes + hookRouter + hookClient + hookInstaller (split) + drainTranscript + tests + Fastify endpoint registration. Old code still runs.
3. **PR-3 Switch wiring** — multiBotRuntime + bot/runtime/history use Registry. **Regression tests must fail on revert, pass after.** Manual staging smoke.
4. **PR-4 Delete dead code** — sessionMonitor, monitorState, session.ts, hook.ts; remove old tests; slim statusPolling.
5. **PR-5 Cleanup docs** — codexSessions scan removal; CLAUDE.md + topic-architecture.md + message-handling.md updates.

PR-3 is the critical hop; PR-4 is pure deletion.

---

## 8. Open Questions / Future Work

- v2 hook entrypoint optimization (`hook-shim.cjs`) if 200ms per-turn latency becomes noticeable
- Codex `SessionEnd` substitute (currently relies on overwrite + window death)
- Multi-host / multi-tenant deployment (currently single-host single-service)
- Hook event journal for stricter delivery guarantees (currently best-effort)
