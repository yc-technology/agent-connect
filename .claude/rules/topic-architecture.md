# Topic-Only Architecture

The bot operates exclusively in Telegram Forum (topics) mode. There is **no** `active_sessions` mapping, **no** `/list` command, **no** General topic routing, and **no** backward-compatibility logic for older non-topic modes. Every code path assumes named topics.

## 1 Topic = 1 Window = 1 Session

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Topic ID   │ ───▶ │ Window ID   │ ───▶ │ Session ID  │
│  (Telegram) │      │ (tmux @id)  │      │  (Claude)   │
└─────────────┘      └─────────────┘      └─────────────┘
   thread_bindings    sessions table
   (SQLite)           (SQLite, UNIQUE on window_id)
```

Window IDs (e.g. `@0`, `@12`) are guaranteed unique within a tmux server session. Window names are kept in the `windows` table as `display_name`.

## Mapping 1: Topic → Window ID (`thread_bindings` table)

```sql
SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?;
```

- Storage: `bots/<id>/bot.sqlite`. `SessionManager` still owns the in-memory mirror and writes to this table (via `state.json` write-through until PR-removes-session.ts lands).
- Written when: user creates a new session via the directory browser in a topic.
- Purpose: route user messages to the correct tmux window.

## Mapping 2: Window ID → Session (`sessions` table)

```sql
-- UNIQUE INDEX idx_sessions_window enforces 1 live session per window
SELECT session_id, transcript_path, last_byte_offset FROM sessions WHERE window_id = ?;
```

- Storage: `bots/<id>/bot.sqlite` (`sessions` table).
- Written when: a `SessionStart` hook event arrives. `HookRouter.onSessionStart` runs `DELETE WHERE window_id = ?` then `INSERT` in a single transaction.
- Purpose: `drainTranscript` uses `transcript_path` to know which jsonl to tail.

**Resume note**: When `claude --resume X` causes the hook to report a session id different from the original file's basename, the bot still follows `transcript_path` from the hook payload — there is no longer any session-id → filename inference, so no override is needed.

## Message Flows

**Outbound** (user → Claude):
```
User sends "hello" in topic (thread_id=42)
  → SessionManager.getWindowForThread(uid, 42) → "@0"
  → tmuxManager.sendKeys("@0", "hello")
```

**Inbound** (Claude → user):
```
Claude writes to <transcript_path>
  → Claude fires PostToolUse / Stop hook
  → agc hook → POST /hook/events { tmux_session, window_id, payload }
  → HookRouter.dispatch (per-window queue) → drainTranscript(sessionId)
  → drainTranscript: per-session lock → read [last_byte_offset, EOF) → parse → setOffset
  → dispatcher → runtime.handleNewMessage → SessionManager.findUsersForWindow(@0)
  → MessageQueueManager → Telegram (correct user + thread_id)
```

**New topic flow**: First message in an unbound topic → directory browser → select directory → session picker (if existing sessions found) or create window → bind topic → forward pending message. `createAndBindWindow` waits for `SessionRegistry.getSessionByWindow(windowId)` to be populated by the inbound `SessionStart` hook (with the `session_map.json` poll kept as a legacy fallback).

**Resume session flow**: When selecting a directory with existing Claude sessions, a session picker UI is shown. Choosing a session runs `claude --resume <session_id>`. The bot trusts `transcript_path` from the hook payload, so any session-id divergence is harmless.

**Topic lifecycle**: Closing/deleting a topic auto-kills the associated tmux window and unbinds the thread. Stale bindings (window deleted externally) are cleaned up by the status-polling loop and by the FK CASCADE on `windows`.

## Session Lifecycle

**Startup catch-up**: After SQLite is opened and `SessionManager.hydrateFromRegistry` runs, the runtime iterates `registry.allLiveSessions()` and calls `drainTranscript` once per session to deliver any assistant text written while the bot was offline.

**Runtime change detection**:
- `SessionStart` (source `startup` / `resume` / `clear` / `compact`) → `DELETE + INSERT` on the same `window_id` row.
- `SessionEnd` → `drainTranscript` (final read) → `DELETE FROM sessions WHERE session_id`.
- Tmux window vanishes → `StatusPoller` removes the row from `windows`; FK CASCADE clears `sessions`, `thread_bindings`, `user_window_offsets`.
