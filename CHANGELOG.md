# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

中文版：[CHANGELOG_CN.md](./CHANGELOG_CN.md).

---

## 0.3.2 — 2026-05-22

### 🐛 Fixed — turn-level API errors no longer leave Telegram on a stale status

When a turn ends due to an upstream API error (rate_limit, server_error,
billing_error, …), Claude Code fires `StopFailure` — but we weren't
subscribed, so the failure was silent and Telegram stayed on the last
spinner status. Concrete repro: `/compact` got a 500 from Claude's API,
the spinner disappeared from the pane with no completion marker,
`parseStatusLine` returned null, and Telegram was stuck on
"Compacting conversation… 1%" indefinitely.

- `hookInstaller` subscribes Claude to `StopFailure`. Codex doesn't
  emit this event; its install list is unchanged.
- `hookRouter` dispatches `StopFailure` → `onDrain` (catch any partial
  output written before the error) → `fireStopFailure` → `fireTurnEnd("failure")`.
- `fireStopFailure` formats `❌ Turn failed (server_error) — <message>`
  and pushes through the existing `onStatusEvent` channel — the active
  status message is OVERWRITTEN with the error text, replacing the
  stuck spinner.
- `fireTurnEnd("failure")` was already wired in `multiBotRuntime`
  (sets 🤔 on the last assistant message instead of 👌); this is the
  first real caller of the failure outcome.

`agc hook --install` now writes `StopFailure` into
`~/.claude/settings.json` on every bot startup; existing installs pick
it up automatically on the next service restart.

### ✨ Added — `/resume` slash command + recovery-aware fallback

- `/resume` joins `/clear`, `/compact`, `/cost`, `/help`, `/memory`,
  `/model` in the forwarded slash-command set. Typing `/resume` in
  Telegram forwards `/resume` into the bound tmux window; Claude
  opens its native TUI session picker, which terminalParser's
  `ResumeSession` pattern already scrapes and `interactiveUi` already
  surfaces with an inline ↑/↓/Enter/Esc keyboard. Zero new delivery
  code — purely menu + plumbing.
- `forwardCommandHandler` previously responded `❌ No session bound to
  this topic.` whenever `resolveWindowForThread` returned null. After
  0.3.1's soft-delete, the binding row can still exist with
  `window_id = NULL` + a `last_session_id` anchor — the binding IS
  there, just detached. Now the handler queries `getRecoveryAnchor`
  and emits a recovery-specific message pointing the user at the
  implicit-join flow instead.

---

## 0.3.1 — 2026-05-22

### 🐛 Fixed — tmux outage no longer wipes the bot DB

After ~13 hours of running, the tmux server died (a known tmux 3.6a
internal bug on macOS 26.2 Apple Silicon — see
[tmux/tmux#4777](https://github.com/tmux/tmux/issues/4777)). The bot's
next status-poll tick saw every binding's window missing,
`cleanupTopicBinding` ran for all of them, and FK CASCADE wiped
`sessions` + `thread_bindings` + `user_window_offsets` in one tick.
Five topics lost their session anchors at once.

- `tmuxManager.listWindowsAuthoritative()` returns a discriminated
  union `{ok:true,windows} | {ok:false,reason}`. Server-unreachable,
  session-missing, and exec-error now have distinct reasons rather
  than collapsing into "empty list".
- `statusPolling.tick` does ONE authoritative call per tick. On
  `{ok:false}` → log + return without touching the binding loop.
  Bindings survive the outage.
- On `{ok:true}` the resolved window is plumbed down to
  `updateStatusMessage`, dropping the second-lookup per binding
  (exec rate goes from 3/binding/tick to 1+N/tick — ~5× fewer tmux
  forks for the same workload).
- Default poll interval bumped 1s → 2s. Override with
  `AGENT_CONNECT_STATUS_POLL_INTERVAL_MS`.

### ✨ Added — soft-delete bindings + resume picker default-highlight

When a window does authoritatively disappear from tmux (server back
but specific window gone), the binding is now **preserved** so the
user can re-join and resume the same session in one tap.

- Schema migration: `thread_bindings.window_id` is now nullable; FK
  is `ON DELETE SET NULL` (was CASCADE); new column
  `recovery_pending`. SQLite has no `ALTER COLUMN`, so the migration
  uses the standard table-recreate dance inside a transaction.
  Idempotent — guarded by PRAGMA shape check (column + nullable + FK
  action all verified).
- New column `last_session_id`: every `SessionStart` hook (incl.
  `lazyRegisterIfMissing`) writes the session_id into the binding
  row. Survives `/clear`, `/compact`, manual `--resume`, and
  auto-recovery uniformly.
- `markBindingForRecovery(userId, threadId)` clears `window_id` +
  sets `recovery_pending=1`, then deletes the windows row so the FK
  SET NULL fires. The binding row stays, last_session_id stays.
- `buildSessionPicker` accepts `recommendedSessionId`. The matching
  row gets a ★ prefix + "(previous)" tag in the markdown and ★ on
  its button. `/join` flow looks up
  `sessionManager.getRecoveryAnchor(userId, threadId)` and passes it
  through, so users see the obvious default after a tmux restart.
- On the `down → up` transition, statusPolling sends a Telegram
  heads-up per recoverable thread: "tmux server was restarted. The
  previous session for this topic (session xxxx) is preserved — send
  any message in this topic to /join and resume it."

### 🐛 Fixed — silent picker delivery failures

`interactiveUi.ts` previously had a `catch { return false }` block
that swallowed every Telegram error. A separate root cause: tmux's
`capture-pane` defaults to capturing only the visible viewport (no
scrollback). For tall AskUserQuestion pickers (verbose option
descriptions), the `☐` top marker scrolled off-screen and the parser
silently failed to match.

- `capturePane` now passes `-S -200` so up to 200 lines of scrollback
  are included. Tall pickers parse correctly.
- `terminalParser.tryExtract` flipped to bottom-up scan: with
  scrollback we can now see older dismissed pickers above the live
  one, and a top-down scan would lock onto the stale one. Bottom-up
  always picks the latest. Multi-line `top` patterns (e.g.
  ResumeSummaryPrompt) still resolve correctly — each regex is
  matched independently and the earliest hit is taken.
- `interactiveUi` now logs the actual error on every silent-fail
  path, throttled at 60s per (windowId, error class).

### 🧹 Internal

- `errorMessage(unknown): string` helper extracted to `utils.ts`
  (dedup with `statusPolling.ts`); handles grammy's `.description`
  field on Telegram API errors.
- 27 new tests across `sessionRegistry` / `session` / `statusPolling`
  / `directoryBrowser` / `terminalParser`; codex-flagged edge cases
  pinned (NULL hydration, recovery_pending filter, migration shape
  probe, multi-picker scrollback).

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

### 📖 Docs

- README now has a **Quick Start (npm install)** section that walks new
  users from `npm i -g @yc-tech/agent-connect-cli` through first
  end-to-end message, with a common-gotchas table. Suitable for handing
  to a Claude / Codex session — agents reading the README can guide
  the user through setup directly (skill-based onboarding was
  considered but rejected: skills don't auto-install until after the
  daemon runs once, so they'd be invisible during the very moment
  they're needed). README_CN.md mirrors the same section.

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
