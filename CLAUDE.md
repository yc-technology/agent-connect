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
- **HTML formatting** — Markdown is converted to Telegram HTML through the workspace `@yc-tech/telegramify-markdown` package, with plain-text fallback.
- **Hook-driven runtime** — Claude and Codex hooks POST events to the bot's Fastify `/hook/events` endpoint; `HookRouter` serializes per-window events and `drainTranscript` reads `transcript_path` from the hook payload. No polling, no `session_map.json`.
- **SQLite per bot** — `bots/<id>/bot.sqlite` holds `windows` / `sessions` / `thread_bindings` / `user_window_offsets`. Window kill cascades to dependent rows via FK.
- **Message queue per user** — FIFO ordering, message merging, and tool_use/tool_result pairing live in the send queue.
- **Intermediate messages default off** — Telegram receives a temporary `Thinking...` status and the final answer unless enabled in config.
- **Daemon mode (optional)** — `agc start --daemon` spawns a detached supervisor (state in `~/.agent-connect/supervisor.json`) that forks the bot service as a child, polls `/healthz` every 10 s, and respawns on failure with exponential backoff. `agc restart` sends SIGUSR2 to the supervisor to reload the on-disk code; `agc stop` SIGTERMs it. Manual `agc start` (foreground) is unchanged.
- **Default HTTP port 17666** — chosen to avoid RStudio Server's 8787 default. Override with `AGENT_CONNECT_HTTP_PORT`. The bundled web console is served by Fastify at `/` in daemon mode.

## Configuration

- Config directory: `~/.agent-connect/` by default, override with `AGENT_CONNECT_DIR`.
- `.env` loading priority: repo `.env` then config dir `.env`.
- Bot settings are stored in SQLite at `$AGENT_CONNECT_DIR/agent-connect.sqlite` unless `AGENT_CONNECT_DB_FILE` is set.
- Runtime state lives in `$AGENT_CONNECT_DIR/bots/<bot-id>/bot.sqlite`; on first launch the legacy `state.json` / `session_map.json` / `monitor_state.json` are imported and renamed `.migrated-YYYY-MM-DD`.
- Service writes `$AGENT_CONNECT_DIR/runtime.json` (`{httpHost, httpPort, pid}`) at startup so `agc hook` knows where to POST; removed on graceful shutdown. Startup refuses to launch if another listener answers on the recorded port.
- Daemon mode writes a separate `$AGENT_CONNECT_DIR/supervisor.json` (`{supervisorPid, serverPid, restartCount, lastHealthCheck*, …}`) — `agc status` / `agc stop` / `agc restart` read this. Removed on supervisor SIGTERM.

## Hook Configuration

Auto-install:

```bash
agc hook --install
```

Expected generated hook command:

```text
agc hook
```

Hook discovery is fully dynamic — `agc hook` reads `runtime.json` for
the current host/port. **Changing `AGENT_CONNECT_HTTP_PORT` does not
require reinstalling hooks.**

## Operations (running + restarting)

### Reload after a source change

```bash
pnpm -r build && agc restart    # daemon mode (typical install)
```

`agc restart` sends SIGUSR2 to the supervisor; supervisor kills its
server child via `tree-kill` and re-spawns from disk. New `dist/`
loaded immediately. Supervisor itself stays up (≈2-5 s TG downtime
during respawn).

### What `agc restart` does NOT reload

- **Supervisor source code itself.** Supervisor was loaded once at
  `agc start --daemon`. To pick up changes to `supervisor.ts`:
  `agc stop && agc start --daemon`.
- **CLI source code.** Each `agc` invocation is a fresh process,
  so any cli change takes effect on the next `agc <cmd>` automatically
  — no restart needed.

### Other common commands

```bash
agc status                    # uptime / restartCount / last + live healthz
agc logs                      # tail ~/.agent-connect/logs/current.log
agc stop                      # SIGTERM supervisor (it cleans up child)
agc stop --force              # SIGKILL skip-grace
agc stop --all                # also kill foreground runtime.json owner
                              # (rare: a foreground `agc start` running in parallel)
```

`agc stop` defaults to safe mode: never touches a runtime.json pid that
isn't `supervisor.serverPid`. Pass `--all` only when you've verified the
other pid is also yours.

### Switching foreground → daemon (or back)

The two modes are mutually exclusive (anti-double-start tcpProbe on the
port). Safe sequence:

```bash
# from `pnpm dev:bot` foreground:
# 1. Ctrl-C the foreground (wait for clean exit)
# 2. agc start --daemon
# 3. agc status   # verify healthz ✓
# 4. send a TG message to verify end-to-end
```

Rollback when daemon misbehaves:

```bash
agc stop --force
pnpm dev:bot
```

State (SQLite bots/, thread_bindings, etc.) is shared between the two
modes — no migration needed.

### Hot logs grep

```bash
tail -f ~/.agent-connect/logs/current.log | jq -c 'select(.level >= 40)'  # warns+errors
tail -f ~/.agent-connect/logs/current.log | jq -c 'select(.windowId == "@8")'  # one window
grep '"msg":"lazy-registered session"' ~/.agent-connect/logs/current.log | jq
```

`current.log` is a symlink that follows daily rotation, so the `tail -f`
stays valid across midnight.

### Smoke-test a fresh daemon without disturbing the running one

Anti-double-start (`service.ts:31`) tcpProbes the recorded port. To
smoke a separate daemon in parallel, isolate via env:

```bash
AGENT_CONNECT_DIR=/tmp/agc-smoke \
  AGENT_CONNECT_HTTP_PORT=17777 \
  AGENT_CONNECT_TS_ENABLE_TELEGRAM=false \
  agc start --daemon
# ... poke / verify ...
AGENT_CONNECT_DIR=/tmp/agc-smoke agc stop
rm -rf /tmp/agc-smoke
```

Without `AGENT_CONNECT_DIR=/tmp/...`, the smoke daemon would refuse to
start (real daemon still listening on its port). **Do not omit the
isolation** — without it, the smoke daemon's `agc stop` may read the
real daemon's `runtime.json` and kill it.

### Gotcha: build while bot is live

`pnpm -r build` triggers `tsdown` on `@yc-tech/telegramify-markdown`,
which rm's the package's `dist/` before recompiling. There is a
sub-second window where `dist/index.mjs` doesn't exist. If a hook fires
during that window, `agc hook` → import bot/dist → import telegramify
dist → ERR_MODULE_NOT_FOUND. Usually self-corrects on the next hook
fire. To avoid entirely, `agc stop` before `pnpm -r build`.

### Env knobs (operational)

| Var | Default | What |
|---|---|---|
| `AGENT_CONNECT_DIR` | `~/.agent-connect` | Root for sqlite, logs, runtime/supervisor json |
| `AGENT_CONNECT_HTTP_PORT` | `17666` | Listen port (anti-clash with RStudio's 8787) |
| `AGENT_CONNECT_LOG_LEVEL` | `info` | pino level |
| `AGENT_CONNECT_LOG_STDOUT` | unset | Set `=1` to mirror logs to stdout too |
| `AGENT_CONNECT_STATUS_THROTTLE_MS` | `3000` | Min spacing between status edits per (user, thread) |
| `AGENT_CONNECT_IMAGE_AS_DOCUMENT` | `true` | Route tool_result images via sendDocument for full quality (`false` = compressed photo with inline preview) |

## Architecture Details

See @.claude/rules/architecture.md for the system diagram and module inventory.
See @.claude/rules/topic-architecture.md for topic to window to session mapping.
See @.claude/rules/message-handling.md for message queue, merging, and rate limiting.
