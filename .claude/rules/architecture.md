# System Architecture

```text
Telegram Forum Topic
  -> apps/bot SessionManager thread binding
  -> tmux window ID
  -> Claude Code or Codex session
  -> transcript monitor
  -> Telegram message queue
```

## Workspace Modules

- `packages/cli/src/index.ts` - `agc` command line entrypoint (`start`, `hook`, `hook --install`)
- `apps/bot/src/agent-connect/service.ts` - service bootstrap for config, API server, hooks, runtime manager
- `apps/bot/src/agent-connect/server.ts` - Fastify management API
- `apps/bot/src/agent-connect/multiBotRuntime.ts` - starts/stops enabled SQLite-backed bot runtimes
- `apps/bot/src/agent-connect/bot.ts` - Telegram handlers, commands, callback routing
- `apps/bot/src/agent-connect/session.ts` - topic/window/session state and history lookup
- `apps/bot/src/agent-connect/sessionMonitor.ts` - transcript polling and session change detection
- `apps/bot/src/agent-connect/transcriptParser.ts` - Claude/Codex transcript parsing
- `apps/bot/src/agent-connect/tmuxManager.ts` - tmux list/create/send/kill/capture operations
- `apps/bot/src/agent-connect/messageQueue.ts` - per-user FIFO send queue and merge behavior
- `apps/bot/src/agent-connect/messageSender.ts` - Telegram send/edit helpers and fallback behavior
- `apps/bot/src/agent-connect/statusPolling.ts` - terminal status polling and deleted-topic probing
- `apps/bot/src/agent-connect/hook.ts` - Claude/Codex hook installer and hook event processor
- `packages/telegramify-markdown/src/` - Markdown to Telegram HTML/entity conversion
- `apps/web/src/` - React + Vite + Zustand management console

## State

Default config root is `$AGENT_CONNECT_DIR`, usually `~/.agent-connect`.

- `agent-connect.sqlite` stores bot configs.
- `bots/<id>/state.json` stores thread bindings, window states, display names, and offsets.
- `bots/<id>/session_map.json` stores hook-generated window to session mappings.
- `bots/<id>/monitor_state.json` stores transcript byte offsets.

## Design Decisions

- Topic-centric: Telegram topics are the user-facing session list.
- Window ID-centric: runtime routing uses tmux IDs like `@0`, not mutable window names.
- Hook-based tracking: Claude and Codex hooks keep window/session mappings fresh.
- Formatting is Telegram HTML, produced by the workspace formatter package.
- Intermediate Telegram noise is off by default; the bot sends a temporary `Thinking...` status and then the final answer.
