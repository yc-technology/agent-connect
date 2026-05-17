# Agent Connect

[中文文档](README_CN.md)
[Русская документация](README_RU.md)

Control Claude Code or Codex sessions remotely via Telegram. Agent Connect keeps the
agent process in a local tmux window, reads its output, and sends keystrokes back
to that same terminal session.

## Features

- Topic-based sessions: one Telegram Forum topic maps to one tmux window.
- Multi-bot configuration stored in SQLite with a React management console.
- Claude Code and Codex support, including hook-based session tracking.
- Telegram notifications for final answers by default, with optional intermediate tool/status messages.
- Directory browser, session resume, history, screenshots, and slash command forwarding.
- Markdown to Telegram HTML formatting through the workspace `@agent-connect/telegramify-markdown` package.

## Requirements

- Node.js 22+
- pnpm 10.6.3+
- tmux
- Claude Code (`claude`) and/or Codex (`codex`) available in PATH

## Install And Run

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts:

- Fastify API and bot service on `127.0.0.1:8787`
- React management console on `127.0.0.1:5173`

Common commands:

```bash
pnpm dev:bot       # bot/API only
pnpm dev:web       # web console only
pnpm start         # run compiled CLI service
pnpm hook:install  # synchronize Claude and Codex hooks
pnpm typecheck
pnpm build
pnpm test:ts
```

To expose `agc` globally from this workspace:

```bash
pnpm --filter agent-connect build
cd packages/cli
pnpm link --global
agc help
```

After linking, `agc` points to the TypeScript CLI.

For npm distribution, publish the workspace packages and install the CLI package:

```bash
pnpm -r publish
npm install -g agent-connect
```

## Telegram Setup

1. Chat with [@BotFather](https://t.me/BotFather) to create a bot and get the bot token.
2. Open @BotFather's profile page and launch the mini app.
3. Select your bot, then go to **Settings** > **Bot Settings**.
4. Enable **Threaded Mode**.
5. Start `pnpm dev`, open `http://127.0.0.1:5173`, and add the bot config.

`ALLOWED_USERS` expects Telegram numeric user IDs, not phone numbers.

## Configuration

The runtime loads `.env` from the repo root and `$AGENT_CONNECT_DIR/.env`.

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_CONNECT_DIR` | `~/.agent-connect` | Config/state directory |
| `AGENT_CONNECT_DB_FILE` | `$AGENT_CONNECT_DIR/agent-connect.sqlite` | SQLite database path |
| `AGENT_CONNECT_TS_ENABLE_TELEGRAM` | `true` | Start enabled bot runtimes |
| `TMUX_SESSION_NAME` | `agent-connect` | Default tmux session name |
| `CLAUDE_COMMAND` | `claude --permission-mode bypassPermissions` | Claude launch command |
| `CODEX_COMMAND` | `codex --yolo` | Codex launch command |
| `MONITOR_POLL_INTERVAL` | `2.0` | Transcript polling interval in seconds |
| `AGENT_CONNECT_TOPIC_PROBE_INTERVAL` | `60.0` | Deleted-topic probe interval; `0` disables probing |
| `AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES` | `false` | Send full thinking/tool/local command messages |
| `AGENT_CONNECT_SHOW_HIDDEN_DIRS` | `false` | Show hidden directories in the directory browser |
| `OPENAI_API_KEY` | none | API key for voice transcription |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI API base URL |

Proxy variables from `.env` are applied to Telegram/OpenAI HTTP requests:

```ini
export HTTP_PROXY=http://127.0.0.1:7890/
export HTTPS_PROXY=http://127.0.0.1:7890/
export http_proxy=http://127.0.0.1:7890/
export https_proxy=http://127.0.0.1:7890/
export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost
```

## Hooks

The bot synchronizes Claude and Codex hooks on startup. Manual repair:

```bash
agc hook --install
```

The generated hook command is:

```text
agc hook
```

For environments where hook processes do not inherit your shell `PATH`, override
it explicitly before installing hooks, for example
`AGENT_CONNECT_HOOK_COMMAND=/absolute/path/to/agc agc hook --install`.

Codex also needs `[features].hooks = true`; `agc hook --install` keeps that
setting synchronized.

## Data Storage

| Path | Description |
| --- | --- |
| `$AGENT_CONNECT_DIR/agent-connect.sqlite` | Bot configuration database |
| `$AGENT_CONNECT_DIR/bots/<id>/state.json` | Topic bindings, window states, display names, read offsets |
| `$AGENT_CONNECT_DIR/bots/<id>/session_map.json` | Hook-generated window to session map |
| `$AGENT_CONNECT_DIR/bots/<id>/monitor_state.json` | Transcript byte offsets |
| `~/.claude/projects/` | Claude Code session data, read-only |
| `~/.codex/` | Codex session data and hook config |

## Workspace Layout

```text
apps/bot/                       TypeScript bot runtime and Fastify API
apps/web/                       React + Vite + Zustand management console
packages/cli/                   `agc` command line entrypoint
packages/telegramify-markdown/  `@agent-connect/telegramify-markdown` formatting package
doc/                            Project notes
scripts/                        Local operations
```
