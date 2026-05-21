# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

中文版：[CHANGELOG_CN.md](./CHANGELOG_CN.md).

---

## 0.3.0 — 2026-05-21

### ✨ Added — `agc send <path>` outbound file delivery

- New CLI subcommand: `agc send /tmp/build.zip [--caption "..."]` sends
  a local file (up to 50 MB) as an uncompressed Telegram document to the
  topic bound to the caller's tmux window. Uses the running bot's
  message queue so the upload competes fairly with normal transcript
  drains; default caption is `📎 <filename> (<size>)`.
- New HTTP endpoint `POST /bot/send-file` (body: `{ path, windowId,
  tmuxSession, caption? }`) backing the CLI. Returns 400 / 404 / 413
  for validation failures; 502 when all delivery attempts fail; 200
  with `{ deliveries, failed }` for partial success.
- Server now AWAITS message-queue drains before responding, so the CLI
  no longer reports "sent" when Telegram is down or 429-exhausted.

### ✨ Added — bundled skills auto-install into ~/.claude & ~/.codex

- `apps/bot/skills/<name>/**` directory trees ship inside the npm
  package (under `dist/skills/`) and are recursively synced into
  `~/.claude/skills/<name>/` and `~/.codex/skills/<name>/` on every
  bot service startup. Per-file byte compare, silent on no-op,
  best-effort (a failed install never blocks startup).
- New skill `agc-send-file`: tells Claude / Codex to call
  `agc send <path>` instead of trying to base64-encode binaries when
  the user asks for a file.
- New skill `agent-connect-setup`: step-by-step setup + debug guide
  the user's agent can walk through after `npm i -g
  @yc-tech/agent-connect-cli`. Covers BotFather, threaded mode,
  ALLOWED_USERS, daemon start, hook install, first message test,
  and common failure modes with the exact log greps to diagnose them.

### 🐛 Fixed — parseStatusLine walks past Claude telemetry prompts

- Walk-back now skips lines prefixed with `⏺` (U+23FA, RECORD-CIRCLE) —
  Claude's "Can Anthropic look at your session transcript?" prompt
  uses this glyph and was terminating walk-back early, so the bot
  would show a stuck `Thinking…` for the whole compute instead of the
  live spinner text (`Hashing… (3m 21s ↓ 9.1k tokens)`). The previous
  `●` (U+25CF) skip rule for the "How is Claude doing this session?"
  rating prompt didn't cover this codepoint.

### 🔧 Internal

- `ToolResultImage` gained an optional `filename` field so callers can
  override the synthesized `image.bin`-style fallback (used by the
  new `agc send` path to surface the real basename).
- Tests: +12 cases (8 dispatcher + 1 queue-filename + 3 parser/skills).
  357 total, all passing.

---

## 0.2.1 — 2026-05-19

### 🐛 Fixed

- Telegram image quality: `sendPhoto` recompresses to ~1280px JPEG-ish,
  which destroys legibility on screenshots / dense UI captures. New
  default routes image-bearing tool_results to `sendDocument` (no
  compression, original quality, 50 MB cap). Modern Telegram clients
  still render an inline thumbnail for image documents — the UX
  difference is minor; the quality gain is large.

### 🎛 New env knob

- `AGENT_CONNECT_IMAGE_AS_DOCUMENT` (default `true`). Set to `false` to
  opt back into the old compressed-but-inline-preview photo path.

---

## 0.2.0 — 2026-05-19

### ⚠️ Breaking

- **Default HTTP port changed from `8787` to `17666`** to avoid clashing
  with RStudio Server (which also defaults to 8787). Override via
  `AGENT_CONNECT_HTTP_PORT` if you need the old port. Hooks discover the
  port dynamically via `runtime.json`, so no reinstall is needed.
- The web console URL therefore moved to `http://127.0.0.1:17666/` (or
  whichever port you set).

### ✨ Added — Daemon mode

- `agc start --daemon` (alias `-d`) — spawn a detached supervisor that
  forks the bot service as its child and stays out of your shell.
- `agc stop` — graceful shutdown of supervisor + server. Smart enough to
  also stop a non-daemon foreground bot when no supervisor exists.
  `--force` (SIGKILL) and `--all` (also kill unrelated server in the same
  config dir) escape hatches available.
- `agc restart` — SIGUSR2 to supervisor; respawns the server child so
  any new on-disk code (after `npm i -g @yc-tech/agent-connect-cli@latest`,
  `git pull && pnpm build`, etc.) takes effect without a full stop/start.
- `agc status` — uptime, restart count, last health check + live healthz
  probe. Exit code 0/1/2 makes it scriptable.
- `agc logs` — tail `~/.agent-connect/logs/current.log` (survives
  rotation via watchFile polling on the symlink).
- Supervisor state machine with single-flight restart mutex: concurrent
  triggers (manual SIGUSR2, healthz-failure auto-restart, child-exit
  respawn) coalesce safely.
- Health monitoring: `GET /healthz` every 10s, restart after 3
  consecutive failures, exponential backoff respawn on child exit
  (1s / 2s / 5s / 10s / 30s).
- `supervisor.json` persists daemon state next to `runtime.json`; CLI
  cross-checks pid liveness via `process.kill(pid, 0)`.

### ✨ Added — Web console served by the bot

- The bundled React management console is now served by Fastify at `/`.
- `npm i -g @yc-tech/agent-connect-cli` users get the console out of the
  box (no separate vite dev server, no extra install).
- `pnpm dev` workflow unchanged — vite still serves the console on
  `:5173` during local development.

### ✨ Added — Claude tool images surface in Telegram

- Image-bearing `tool_result` entries (e.g. Claude's screenshot tool) now
  bypass the default `showToolCalls=false` suppression and arrive in
  Telegram as a captioned photo (`📷 <ToolName>`).
- `sendPhoto` falls back to `sendDocument` on Telegram's photo
  rejections (`PHOTO_INVALID_DIMENSIONS`, 10 MB cap, etc.); document
  upload preserves original quality, 50 MB cap.
- Known-unsupported MIME types (SVG, TIFF, PDF, …) skip the photo
  attempt entirely via an allowlist.
- Filename derives from `mediaType` so saved files get the right
  extension (`.png` / `.jpg` / `.webp` / …).

### ✨ Added — Rate-limit hardening

- Status edits throttled at `AGENT_CONNECT_STATUS_THROTTLE_MS` (default
  `3000`) so the per-second tick of "Compacting conversation… (Xs) NN%"
  doesn't burn through Telegram's edit cap.
- Content-path 429 retry: `sendWithFallback` and tool_result
  `editWithFallback` now honor the server-supplied `retry_after`,
  re-trying up to 4 times before giving up. Previously the retry-after
  signal was silently dropped and the content was lost.
- `isRetryAfter` recognizes grammY's `error.parameters.retry_after`
  shape in addition to the legacy direct fields.

### ✨ Added — Structured logging

- pino + pino-roll daily-rotating logs at
  `~/.agent-connect/logs/agent-connect.<YYYY-MM-DD>.<N>.log`.
- `current.log` symlink always points at the active file —
  `tail -f current.log` survives rotation.
- 30-file retention cap (~1.5 GB worst case with the 50 MB per-file
  guard).
- Every `console.*` in production code paths migrated to a shared
  logger with structured fields (windowId, sessionId, event, userId, …).
- Env knobs: `AGENT_CONNECT_LOG_LEVEL` (default `info`),
  `AGENT_CONNECT_LOG_STDOUT=1` to also mirror to stdout.

### ✨ Added — TUI matchers

- Claude `/resume` session picker now surfaces in Telegram with the
  inline keyboard.
- "Resume from summary?" long-session warning (the one Claude shows
  after picking an old, large session) also surfaces.

### 🐛 Fixed — Drain-from-0 family

These were the "Telegram suddenly floods with hundreds of old messages"
bugs.

- `SessionStart source=resume`: offset is seeded to current transcript
  EOF instead of 0, so `claude --resume <id>` no longer re-emits the
  entire prior conversation.
- `SessionStart source=compact`: same fix — Claude does NOT truncate
  the jsonl during compact (it appends a summary), so naive drain-from-0
  would re-emit everything we already delivered.
- `lazyRegisterIfMissing`: bot starting after Claude/Codex was already
  running, or topic bound to a pre-existing tmux window — also seeds
  offset to EOF instead of replaying history.
- Helper `offsetSkippingHistory` extracted; per-source rationale
  documented in one place.

### 🐛 Fixed — Compact UX

- "✨ Compact done — ready to continue" notification when `/compact`
  finishes (compact ends silently in the TUI; Telegram users had no
  signal before).
- Live progress in status during compact:
  `Compacting conversation… (17s) 18%` (progress bar percent harvested
  from the TUI capture).

### 🐛 Fixed — Status regex

- Accented past-tense verbs (`Sautéed for 17s`, `Flambéed for 5s`) —
  the previous ASCII-only `[A-Za-z]` silently let these through and
  they showed up as still-active status until the next message
  overwrote them.
- `· side note` suffix (`Brewed for 34s · 1 shell still running`) —
  background-state annotations no longer prevent the "completed" match.
- Multi-unit durations (`Worked for 1m 5s`, `Cooked for 2h 13m`,
  `Sautéed for 2h 13m 45s`).

### 🐛 Fixed — Daemon CLI safety

- `agc stop` no longer kills unrelated processes that happen to own
  `runtime.json` (the May-19 "smoke test killed the foreground bot"
  incident). When a live supervisor exists with a different serverPid,
  the runtime.json owner is treated as foreground-bot-running-in-
  parallel and left alone unless `--all` is passed.
- `agc start --daemon` refuses to start if a supervisor is already
  alive; sweeps stale `supervisor.json` from a crashed prior run before
  proceeding.
- Reports a clear error on spawn failure instead of
  `agc supervisor started (pid undefined)`.

---

## 0.1.1 — 2026-05-19

See git log between tags `0.1.0...0.1.1` for the full set of bug fixes
and structured-logging groundwork that preceded 0.2.0.

## 0.1.0 — 2026-05-19

Initial published release on npm under the `@yc-tech` scope.
