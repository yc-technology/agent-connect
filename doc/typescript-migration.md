# TypeScript Migration

The TypeScript runtime lives in a pnpm monorepo. The workspace contains the bot
runtime, Fastify management API, CLI package, Telegram formatting package, and
React management console.

## Layout

- `apps/bot/src/agent-connect/` - TypeScript bot runtime and Fastify API
- `apps/bot/tests/` - Vitest coverage for migrated behavior
- `apps/web/src/` - React + Vite + Zustand management console
- `packages/cli/src/` - command line entrypoints for service startup and hooks
- `packages/telegramify-markdown/src/` - `@agent-connect/telegramify-markdown` Telegram HTML formatting package
- `apps/bot/dist/` and `apps/web/dist/` - build output, ignored by git
- `pnpm-workspace.yaml` - workspace definition for `apps/*` and `packages/*`

## Package Manager

Use pnpm from the repo root:

```bash
pnpm install
pnpm typecheck
pnpm test:ts
pnpm build
```

Common development commands:

```bash
pnpm dev
pnpm dev:bot
pnpm start
pnpm hook:install
```

`pnpm dev` starts both the bot API and the web console. The web console runs on
`http://127.0.0.1:5173` and proxies `/api` to the bot API at
`http://127.0.0.1:8787`. `pnpm dev:bot` and `pnpm dev:web` are available when
only one side is needed.

`pnpm dev:bot`, `pnpm start`, and `pnpm hook:install` are backed by the
`agent-connect` CLI package. Its binary supports `agc start`, `agc hook`, and
`agc hook --install`; hook synchronization points Claude and Codex back to
that CLI entrypoint.

## SQLite And Multi Bot

The TS runtime stores bot configuration in SQLite through the stable
`better-sqlite3` package:

- default path: `$AGENT_CONNECT_DIR/agent-connect.sqlite`
- override: `AGENT_CONNECT_DB_FILE=/path/to/agent-connect.sqlite`
- table: `bot_configs`

Each bot has its own runtime state directory:

```text
$AGENT_CONNECT_DIR/bots/<bot-id>/state.json
$AGENT_CONNECT_DIR/bots/<bot-id>/session_map.json
$AGENT_CONNECT_DIR/bots/<bot-id>/monitor_state.json
```

On startup, legacy `.env` values are imported as a `default` bot when
`TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` are present. Additional bots can be
created from the management API or web console. Enabled bots are loaded when the
process starts.

Management API changes are applied live: creating an enabled bot starts it,
disabling a bot stops it, re-enabling or changing a bot restarts it, and
deleting a bot stops its runtime before removing the row.

Claude and Codex hooks route session mappings by `tmux_session_name`, so one
global hook can write to the correct bot-specific `session_map.json`. The TS
runtime synchronizes these hooks on startup; `pnpm hook:install` remains
available as a manual repair command.

Management routes:

- `GET /api/bots`
- `GET /api/bots/:id`
- `POST /api/bots`
- `PATCH /api/bots/:id`
- `DELETE /api/bots/:id`

Tokens and API keys are write-only in API responses. Responses expose
`telegramBotTokenSet` and `openaiApiKeySet` booleans instead.

## Runtime Flags

By default, `pnpm dev` starts the Fastify API, web console, and all enabled
Telegram bots:

```bash
pnpm dev
```

Use management-only mode when you want the API and web console without Telegram
polling:

```bash
AGENT_CONNECT_TS_ENABLE_TELEGRAM=false pnpm dev
```

Telegram polling also enables session monitoring because Telegram delivery
depends on monitor events.

Deleted Telegram forum topics are probed every 60 seconds by default. Set
`AGENT_CONNECT_TOPIC_PROBE_INTERVAL=0` to disable the extra Telegram API request.

## Proxy / VPN

The TS runtime loads `.env` from the repo root and `$AGENT_CONNECT_DIR/.env`. Standard
proxy variables are applied to Node HTTP requests through `undici`, so Telegram
and OpenAI requests can go through a local VPN/proxy client:

```ini
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
ALL_PROXY=http://127.0.0.1:7890
NO_PROXY=127.0.0.1,localhost
```

`HTTPS_PROXY` and `HTTP_PROXY` are preferred. `ALL_PROXY` is used as a fallback
for both when protocol-specific values are not set.

## Current Migration Scope

Ported so far:

- environment/config loading
- pnpm monorepo workspace
- SQLite bot configuration store
- multi-bot runtime startup from enabled SQLite records
- Fastify health/readiness routes and bot management API
- React + Vite + Zustand management console
- live start/stop/restart of bot runtimes after management API changes
- shared file utilities
- Telegram message splitting
- Claude terminal UI/status parsing
- Claude JSONL transcript parsing
- monitor state persistence
- session monitor JSONL offset/polling core
- session/window/thread state manager
- Claude SessionStart hook installer/processor
- grammY bot scaffold with authorization and initial commands
- `/history`, `/esc`, `/unbind`, `/kill`, `/usage`, and Claude slash command
  forwarding
- photo message download/forwarding handler
- unsupported-content handler and Telegram command menu setup
- topic close/rename cleanup handlers
- MarkdownV2 conversion with table and expandable-quote handling
- history pagination callback parsing/editing
- directory browser, window picker, and session picker UI builders
- unbound-topic text flow with existing-window binding, directory browsing,
  new window creation, and existing-session resume callbacks
- screenshot PNG rendering, `/screenshot`, screenshot refresh, and screenshot
  quick-key callbacks
- interactive UI keyboard rendering/callbacks and status/topic-deletion polling
  for bound tmux windows
- bash `!` command output capture/edit loop
- Telegram send fallback helpers and grammY API adapter
- per-user message queue core with status/tool-result handling
- SessionMonitor -> MessageQueueManager -> grammY runtime wiring
- tmux CLI wrapper for list/capture/send/create/rename/kill window operations
- compiled Node entrypoint, `pnpm start`, `pnpm hook:install`, and `agc`
  package bin

Still deferred:

1. voice message handler
2. deployment/service docs for the TS runtime

Voice message handling is intentionally deferred for now.
