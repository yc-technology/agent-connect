# CLAUDE.md

Agent Connect is a TypeScript pnpm monorepo that bridges Telegram Forum topics to local
Claude Code or Codex sessions through tmux windows. Each topic maps to one tmux
window and one agent session.

Tech stack: TypeScript, Node.js, Fastify, grammY, React, Vite, Zustand, SQLite,
tmux, pnpm.

## Common Commands

```bash
pnpm dev             # Start bot/API and web console
pnpm dev:bot         # Start only the bot/API service through the agent-connect CLI package
pnpm dev:web         # Start only the React management console
pnpm typecheck       # Type check every workspace package
pnpm build           # Build every workspace package
pnpm test:ts         # Run Vitest suites
pnpm hook:install    # Synchronize Claude and Codex hooks
./scripts/restart.sh # Restart the Agent Connect service in tmux
```

## Core Design Constraints

- **1 Topic = 1 Window = 1 Session** — internal routing is keyed by tmux window ID (`@0`, `@12`), not window name. Window names are display names only.
- **Topic-only** — no `/list`, no General topic routing, and no compatibility path for old non-topic modes.
- **No parse-layer truncation** — full transcript content is preserved; splitting happens only at Telegram send time.
- **HTML formatting** — Markdown is converted to Telegram HTML through the workspace `@agent-connect/telegramify-markdown` package, with plain-text fallback.
- **Hook-driven runtime** — Claude and Codex hooks POST events to the bot's Fastify `/hook/events` endpoint; `HookRouter` serializes per-window events and `drainTranscript` reads `transcript_path` from the hook payload. No polling, no `session_map.json`.
- **SQLite per bot** — `bots/<id>/bot.sqlite` holds `windows` / `sessions` / `thread_bindings` / `user_window_offsets`. Window kill cascades to dependent rows via FK.
- **Message queue per user** — FIFO ordering, message merging, and tool_use/tool_result pairing live in the send queue.
- **Intermediate messages default off** — Telegram receives a temporary `Thinking...` status and the final answer unless enabled in config.

## Configuration

- Config directory: `~/.agent-connect/` by default, override with `AGENT_CONNECT_DIR`.
- `.env` loading priority: repo `.env` then config dir `.env`.
- Bot settings are stored in SQLite at `$AGENT_CONNECT_DIR/agent-connect.sqlite` unless `AGENT_CONNECT_DB_FILE` is set.
- Runtime state lives in `$AGENT_CONNECT_DIR/bots/<bot-id>/bot.sqlite`; on first launch the legacy `state.json` / `session_map.json` / `monitor_state.json` are imported and renamed `.migrated-YYYY-MM-DD`.
- Service writes `$AGENT_CONNECT_DIR/runtime.json` (`{httpHost, httpPort, pid}`) at startup so `agc hook` knows where to POST; removed on graceful shutdown. Startup refuses to launch if another listener answers on the recorded port.

## Hook Configuration

Auto-install:

```bash
agc hook --install
```

Expected generated hook command:

```text
agc hook
```

## Architecture Details

See @.claude/rules/architecture.md for the system diagram and module inventory.
See @.claude/rules/topic-architecture.md for topic to window to session mapping.
See @.claude/rules/message-handling.md for message queue, merging, and rate limiting.
