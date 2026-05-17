# System Architecture

```text
Telegram Forum Topic
  -> thread_bindings (SQLite, written via SessionManager)
  -> tmux window ID
  -> Claude / Codex session
  -> agent hook -> POST /hook/events
  -> HookRouter (per-window queue)
  -> drainTranscript (per-session lock, reads transcript_path from offset)
  -> runtime.handleNewMessage -> MessageQueueManager -> Telegram
```

No polling. Every transcript read is triggered by a hook event (SessionStart,
PostToolUse, PostToolBatch, PostToolUseFailure, UserPromptSubmit, Stop,
SessionEnd). `StatusPoller` runs on its own 1s cadence purely for the TUI
status line (`Thinking… (Xs)`) and 60s topic probe.

## Workspace Modules

- `packages/cli/src/index.ts` — `agc` command line entrypoint (`start`, `hook`, `hook --install`)
- `apps/bot/src/agent-connect/service.ts` — service bootstrap; writes `runtime.json`, `tcpProbe`s for stale instance, installs hooks, mounts Fastify
- `apps/bot/src/agent-connect/server.ts` — Fastify management API + `POST /hook/events` (`registerHookEndpoint`)
- `apps/bot/src/agent-connect/multiBotRuntime.ts` — starts/stops enabled bots; per-bot SessionRegistry + HookRouter; populates global `hookRouterRegistry`
- `apps/bot/src/agent-connect/bot.ts` — Telegram handlers, commands, callback routing
- `apps/bot/src/agent-connect/session.ts` — `SessionManager` (in-memory state hydrated from `SessionRegistry` on startup; serves bindings to runtime/UI)
- `apps/bot/src/agent-connect/sessionRegistry.ts` — `SessionRegistry`: SQLite-backed windows / sessions / bindings / user_window_offsets + `withSessionLock` per-session mutex
- `apps/bot/src/agent-connect/sessionLookup.ts` — read-only jsonl helpers for `/history` and the resume picker
- `apps/bot/src/agent-connect/drainTranscript.ts` — read `transcript_path` from offset to EOF inside a per-session lock; dispatch parsed entries
- `apps/bot/src/agent-connect/hookRouter.ts` — dispatch hook events; per-window serialization queue
- `apps/bot/src/agent-connect/hookClient.ts` — `agc hook` CLI: read stdin → resolve tmux info → POST `/hook/events`
- `apps/bot/src/agent-connect/hookInstaller.ts` — install Claude (9 events) + Codex (6 events) hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`
- `apps/bot/src/agent-connect/hookTypes.ts` — shared envelope/payload types
- `apps/bot/src/agent-connect/migration.ts` — one-shot JSON → SQLite import on first launch
- `apps/bot/src/agent-connect/runtimeJson.ts` — read/write/remove `$AGENT_CONNECT_DIR/runtime.json` + `tcpProbe`
- `apps/bot/src/agent-connect/transcriptParser.ts` — Claude/Codex transcript parsing
- `apps/bot/src/agent-connect/tmuxManager.ts` — tmux list/create/send/kill/capture operations
- `apps/bot/src/agent-connect/messageQueue.ts` — per-user FIFO send queue and merge behavior
- `apps/bot/src/agent-connect/messageSender.ts` — Telegram send/edit helpers and fallback behavior
- `apps/bot/src/agent-connect/statusPolling.ts` — TUI status line capture + topic-probe loop
- `apps/bot/src/agent-connect/codexSessions.ts` — `findCodexSession` + `listCodexSessionsForDirectory` for the resume picker
- `packages/telegramify-markdown/src/` — Markdown to Telegram HTML/entity conversion
- `apps/web/src/` — React + Vite + Zustand management console

## State

Default config root is `$AGENT_CONNECT_DIR`, usually `~/.agent-connect`.

- `agent-connect.sqlite` stores bot configs (multi-bot manifest).
- `bots/<id>/bot.sqlite` stores per-bot runtime state — see `sessionRegistry.ts`:
  - `windows` (live tmux windows)
  - `sessions` (one live session per window, `UNIQUE(window_id)`, FK CASCADE)
  - `thread_bindings` (Telegram topic ↔ window; includes group_chat_id + topic_probe_message_id)
  - `user_window_offsets` (`/history` pagination cursor)
- `runtime.json` advertises the service's `{httpHost, httpPort, pid}` for the hook client; removed at shutdown.
- Legacy `state.json` / `session_map.json` / `monitor_state.json` are imported and renamed `.migrated-YYYY-MM-DD` on first launch; no longer written.

## Design Decisions

- Topic-centric: Telegram topics are the user-facing session list.
- Window ID-centric: runtime routing uses tmux IDs like `@0`, not mutable window names.
- Hook-driven runtime: every transcript read is triggered by a hook event; no monitor polling.
- Single SQLite per bot; FK CASCADE keeps state coherent on window death.
- Formatting is Telegram HTML, produced by the workspace formatter package.
- Intermediate Telegram noise is off by default; the bot sends a temporary `Thinking...` status and then the final answer.
