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

### Bundled skills auto-install

`apps/bot/skills/<name>/**` directory trees are copied into
`apps/bot/dist/skills/` at build time, then recursively synced into
`~/.claude/skills/<name>/` AND `~/.codex/skills/<name>/` at every bot
service startup. Per-file byte compare; silent log on no-op. Drop new
skills under `apps/bot/skills/` (with `references/`, `assets/`, scripts —
all preserved) and they ship + auto-install on next `agc restart`.

**Bundled wins**: a user hand-edit at `~/.claude/skills/agc-send-file/SKILL.md`
gets overwritten on the next restart and logged as `action: "updated"` —
the installer can't distinguish a user tweak from a stale bundled version.
Power users who want a custom variant should copy the skill folder to a
new name.

The in-tree `agc-send-file` skill tells both agents to call
`agc send <path>` instead of trying to base64 a binary.

### Outbound file delivery (`agc send`)

```bash
agc send /tmp/build.zip                       # default caption "📎 build.zip (size)"
agc send /tmp/notes.pdf --caption "Q2 notes"  # custom caption (truncated at 1024)
```

Must run inside a tmux pane — the CLI resolves `windowId` + `tmuxSession`
via `tmux display-message` and POSTs to the bot's `/bot/send-file`. The
server reads the file itself (same uid) and routes through
`MessageQueueManager` so the upload competes fairly with normal
transcript drains. 50 MB cap (Telegram's `sendDocument` limit). Empty
files and non-regular paths are rejected up front. See
[outboundDispatcher.ts](apps/bot/src/agent-connect/outboundDispatcher.ts).

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
| `AGENT_CONNECT_STATUS_POLL_INTERVAL_MS` | `2000` | statusPolling tick interval. Lower = snappier status, higher = fewer tmux forks per second |
| `AGENT_CONNECT_IMAGE_AS_DOCUMENT` | `true` | Route tool_result images via sendDocument for full quality (`false` = compressed photo with inline preview) |

## Releasing

Use [`@changesets/cli`](https://github.com/changesets/changesets); see
[`docs/release.md`](docs/release.md) for the full walk-through. **Never run
`npm publish` directly** — pnpm's `workspace:*` protocol is not rewritten by
plain npm and the published tarball will contain literal `"workspace:*"` in
its dependencies, which the npm registry can't resolve. 0.3.1 / 0.3.2 / 0.3.3
shipped that way and had to be deprecated; 0.3.4 was the republish.

```bash
pnpm changeset            # interactive: pick packages + patch/minor/major + summary
# commit the generated .changeset/<slug>.md with the code change

# at release time:
pnpm changeset version    # bumps package.json + deletes consumed changesets
# hand-write CHANGELOG.md + CHANGELOG_CN.md entries (changelog: false in config)
git commit + push + git tag v<X.Y.Z>
pnpm changeset publish    # rewrites workspace:* + npm publish + per-package git tags
git push --tags
```

After publish, **always pack-verify** the deps are concrete versions, not
`workspace:*`:

```bash
npm pack @yc-tech/agent-connect-cli@<version>
tar -xOf yc-tech-agent-connect-cli-<version>.tgz package/package.json | jq .dependencies
```

`.changeset/config.json` notes:
- `changelog: false` — CHANGELOG is hand-written. Don't switch this on without removing the per-version sections by hand.
- `fixed: [["@yc-tech/agent-connect-bot", "@yc-tech/agent-connect-cli"]]` — cli imports bot internals, must always bump together.
- `ignore: ["@yc-tech/agent-connect-web"]` — apps/web isn't published; it ships bundled in apps/bot's tarball.

## Conventions & Invariants

Hard-won rules from past incidents. Each has its own scar; preserve
them when refactoring.

### Hook routing

- **`SessionStart` seeds `last_byte_offset` to file EOF for EVERY source.**
  Not just `resume`. Claude's `/compact` does NOT truncate the jsonl
  (it appends a summary entry), so a naive `offset=0` for `compact`
  re-emits the entire historical transcript to Telegram. Same trap for
  `lazyRegisterIfMissing`. The single helper is
  `hookRouter.offsetSkippingHistory(transcriptPath)` — use it for any
  new "fresh session row" path.
- **Foreign-agent filter is load-bearing.** Claude Code 2.x spawns a
  `codex-companion` subprocess that shares the parent's `TMUX_PANE`;
  both fire hooks into the same `/hook/events` endpoint by
  `tmux_session`. `HookRouter.shouldIgnore` rejects events whose
  `transcript_path` doesn't match the bot's configured `agentType`
  (looks for `/.codex/` vs `/.claude/`). Without it, a Codex
  SessionStart can `DELETE+INSERT` over the live Claude session row.
- **Per-window event serialization + per-session drain lock.**
  `HookRouter.windowQueues` (per window) and
  `SessionRegistry.withSessionLock` (per session) together guarantee
  `SessionStart` always completes before any subsequent event for the
  same window, and the same transcript file is never drained
  concurrently. Don't add async work in these paths that bypasses the
  queue/lock.

### CLI safety

- **`agc stop` never touches a `runtime.json` pid it doesn't own.**
  When a live supervisor exists and `runtime.pid !== supervisor.serverPid`,
  the runtime.json owner is treated as a foreign foreground bot and
  left alone (only `--all` overrides). The May-19 smoke-test incident
  killed an unrelated foreground bot via the old "kill any alive pid"
  logic; the new rule prevents it.

### TUI parsing

- **`parseStatusLine` walks back from chrome; skip rules are non-obvious.**
  The walk-back terminates on the first "real" line — so anything
  Claude renders between the spinner and the chrome that isn't a
  recognized attachment will silently break status detection. Current
  skip rules (in `terminalParser.ts:238`):
  - leading whitespace → indented continuation (Tip hints, progress
    bars, numbered choices)
  - `●` prefix → Claude system notifications (rating prompt, plugin
    update banners)
  - `STATUS_SPINNERS` set → match and capture
  - anything else → terminate
  Add to the skip list (with a test) whenever you see a new
  non-spinner non-indented prefix appearing in real panes.
- **`UI_PATTERNS` scan is bottom-up.** `capturePane` includes 200
  lines of scrollback, so the LATEST occurrence of an interactive UI
  must win — top-down would lock onto a stale picker scrolled above.

## Testing & runtime patterns

- **Use `installCaptureLogger`, not `vi.spyOn(console, ...)`.** Business
  code logs through `logger()` (pino) since 0.1.1. The capture helper
  in `apps/bot/tests/helpers/testLogger.ts` returns an object with a
  `records[]` array + `at(level)` filter; tests assert on structured
  fields (`windowId`, `userId`, etc.) instead of brittle string
  matching on the console fallback. See `hookRouter.test.ts` /
  `messageQueue.test.ts` for the pattern.
- **Poll for async state, don't `setTimeout` and hope.** Tests that
  depend on the supervisor's `await persist()` finishing on disk
  before assertions raced on slow CI even though they passed on
  macOS. The pattern in `supervisor.test.ts` "healthz failures past
  the threshold trigger a restart": loop `readSupervisorJson` every
  25 ms up to 3 s waiting for the expected field to appear. Fast on
  fast machines, robust on slow CI.
- **Behavior-flip env vars get explicit opt-out in legacy tests.**
  When you change a default (e.g. 0.2.1's `AGENT_CONNECT_IMAGE_AS_DOCUMENT=true`),
  existing tests asserting the OLD path should set the env var
  inline + clear in `afterEach`. See `messageSender.test.ts` /
  `messageQueue.test.ts` for the pattern. Keeps old assertions valid
  without rewriting them to assert the new path.
- **`MessageQueueManager.drain(userId)` is a chained promise, not
  single-flight.** Earlier versions returned early if `processing.has(userId)`
  was true, which broke the await contract — `Stop`'s onTurnEnd
  reaction would fire before the prior turn's text had been recorded
  by `lastAssistantMessageIds`, attaching the reaction to the wrong
  message. The current chain-based implementation ensures each caller
  awaits THEIR queued work. Don't revert to single-flight.
- **`withRetryAfter` is bounded at 4 attempts.** Content path retries
  on Telegram 429 by sleeping `retry_after`. If exhausted, the wrapper
  re-throws; `runDrainLoop` logs an `error` and drops the task. Grep
  the log for `"messageQueue task failed"` to find lost-content
  incidents.
- **`window` delete cascades.** Schema FK chain:
  `windows → sessions / thread_bindings / user_window_offsets` all
  `ON DELETE CASCADE`. So `registry.deleteWindow(windowId)` cleans up
  the full topic-binding graph in one statement — used by
  `statusPolling.cleanupTopicBinding` when a tmux window vanishes.
  Don't manually delete from child tables; let the FK do its work.

## Architecture Details

See @.claude/rules/architecture.md for the system diagram and module inventory.
See @.claude/rules/topic-architecture.md for topic to window to session mapping.
See @.claude/rules/message-handling.md for message queue, merging, and rate limiting.
