# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

中文版：[CHANGELOG_CN.md](./CHANGELOG_CN.md).

---

## 0.3.11 — 2026-05-28

### 🐛 Fixed — `/kill` missing from the Telegram command menu

The command was registered and worked when typed manually, but the
`BOT_COMMANDS` list (pushed to Telegram via `setMyCommands` to populate
the `/` autocomplete menu) didn't include it — leftover from 0.3.8
when `/unbind` was removed but the replacement entry was never added.
Now `/kill` shows up alongside `/start`, `/history`, `/esc`, etc.

Telegram clients cache the menu per chat for a few minutes — restart
your Telegram app or wait briefly if `/kill` doesn't appear right
after the bot restarts.

---

## 0.3.10 — 2026-05-28

### ✨ Added — SessionSurvey forwarded to Telegram as a 3-button picker

Reported in the wild: a tmux window appeared "stuck" — messages sent
from Telegram weren't reaching Claude. Root cause: Claude was blocked
on its periodic data-usage survey
(`⏺ Can Anthropic look at your session transcript? y: Yes  n: No  d:
Don't ask again`), which holds the TUI input row hostage until you
answer `y` / `n` / `d`. Every Telegram message routed via
`tmux send-keys` was getting eaten by the modal — the user saw no
response and the bot had no idea the survey existed.

The survey is now treated like any other interactive UI:

- New `SessionSurvey` pattern in `terminalParser.ts` matches the
  characteristic `Can Anthropic look at your session transcript`
  header + `y: Yes  n: No  d: Don't ask again` footer.
- `buildInteractiveKeyboard` returns a dedicated 3-button row for this
  pattern (`✅ Yes` / `❌ No` / `🚫 Don't ask again`) instead of the
  standard arrow/Enter keyboard, which would just confuse here.
- New `aq:lit-y/n/d:` callback prefixes wired into
  `INTERACTIVE_KEY_SEND_MAP` with `literal: true` so tmux sends the
  actual character (`tmux send-keys -l y`) rather than treating `y`
  as a named key.

Tap `🚫 Don't ask again` to suppress for the remainder of the session.

No `requireChromeBelow` needed — the `y: Yes ... n: No ... d: Don't
ask` footer is specific enough that no realistic prose collides.

+3 tests: pattern matches a real captured pane, dedicated keyboard
layout, prose mentioning the survey doesn't false-positive without
the footer.

---

## 0.3.9 — 2026-05-27

### 🐛 Fixed — phantom AskUserQuestion picker when prose mentions picker glyphs

Reported in the wild: a Telegram-bound topic was used to discuss the
bot's own picker UI. Claude's response in the tmux pane contained `☐
Option 1` + `Enter to select · ↑/↓ navigate` as prose. The two
glyph-based AskUserQuestion patterns matched on this text →
`extractInteractiveContent` returned a hit → `statusPolling.tick`
rendered a phantom inline-button picker in Telegram → and (since
`statusPolling.tick` early-returns on `isInteractiveUi`) the spinner
status updates stopped firing, so the status line appeared stuck on
"Thinking…".

Both glyph-based Claude AskUserQuestion patterns now require a
long-dash chrome separator (`─` U+2500, ≥5 in a row) within 4 lines
below the matched region. Real Claude TUI always has chrome there
(between the picker and the `❯` input row). Prose discussing pickers
has chrome only at the bottom-of-pane input area, far below — so it
no longer hits.

Scope: only the two glyph-based Claude patterns. Other UI patterns
(Codex's distinctive `Question N/M` + `tab to add notes | enter to
submit answer`, ExitPlanMode, BashApproval, Settings, etc.) keep
their existing matchers because their top/bottom regexes are specific
enough that no realistic prose hits them.

Acknowledged band-aid; documented in the source comment. The proper
fix (planned for 0.4.0) is to subscribe to Claude's `Notification`
hook, set a per-window "pending input" flag when Claude blocks for
user input, and only run picker detection when the flag is set. With
event-driven detection, prose can't trigger phantom pickers at all
because the detection path doesn't run unless Claude has actually
asked. Shipping the heuristic now because the symptom is user-visible
and the proper fix is a 0.4.0-sized refactor.

---

## 0.3.8 — 2026-05-27

Five lifecycle / picker fixes plus a new self-upgrade command.
Reported from a deployment where the bind picker offered bare-shell
tmux windows (rendered as `(unnamed @0\tmain\t/Users/foo/proj\tzsh)`
because parsing was also broken on top of the wrong-window-offered
issue), and repeated `/unbind` cycles piled up `projA`, `projA-2`,
`projA-3` orphans nobody could clean up.

### 🐛 Fixed — `listWindowsAuthoritative` switches to probe-based listing

Stopped trusting multi-field `tmux list-windows -F` output to round-trip
`\t` separators. On at least one user's setup the tabs didn't survive,
which collapsed every field into a single mangled windowId and made
every downstream `-t <id>` operation fail.

The new flow:

1. Fetch the canonical id list in a single-field call
   (`-F '#{window_id}'`) — single-field output has nothing that could
   be mis-split.
2. For each id, run `tmux display-message -t <id> -p` with a newline-
   separated format to fetch `window_name` / `pane_current_path` /
   `pane_current_command`. Newlines are fundamental to terminal I/O
   and far safer separators than `\t`.
3. Probes that fail (window vanished between list and probe) skip the
   row + `warn` with the windowId.

Cost is N+1 tmux execs per refresh instead of 1, but tmux IPC is
local sub-ms and the poller runs at 1-2s — fine.

### 🐛 Fixed — bind picker only shows managed agent windows

`textMessageHandler` now filters unbound windows by
`SessionManager.getSessionByWindow()` — keep only windows the bot has
actually registered a SessionStart hook for. Raw `zsh` / `bash`
windows that the user never started an agent in are no longer offered
in the bind picker; the user falls through to the directory browser
to spawn a fresh session instead.

We use sessions-table presence rather than `pane_current_command`,
because Claude Code sets its own process title to its version string
(e.g. `2.1.147`) — there's no reliable command-name allowlist that
holds across versions and agents.

### 💥 Removed — `/unbind`

Pre-0.3.8 `/unbind` was a soft disconnect that left the tmux window +
claude session alive, which produced orphan windows piling up across
repeated `/unbind` → New Session cycles. Converting it to also kill
the window made it functionally identical to `/kill` minus the
topic-deletion attempt — and `/kill` falls back to the same behavior
when topic deletion fails. Two commands with effectively the same
outcome was confusing, so `/unbind` is gone. Use `/kill` for "tear
this down" (also tries to delete the topic if the bot has permission;
`topicClosedHandler` already cleans up when you close/delete the
topic from the Telegram UI).

### 🐛 Fixed — empty windowName fallbacks

Two related empty-string holes:

- `SessionManager.getDisplayName` used `??` (nullish coalescing),
  which only catches null/undefined; an empty windowName in
  `windowDisplayNames` passed through and surfaced as a literally
  empty name in status templates ("Window '' no longer exists").
  Now falls back to the windowId when the name is empty.
- `handleWindowBindCallback`'s confirmation `✅ Bound to window
  \`${windowName}\`` used the raw windowName and produced `Bound to
  window \`\`` (literal empty backticks) for the same case. Now also
  falls back to the windowId.

### ✨ Added — `agc upgrade` self-upgrade command

```bash
agc upgrade                # @latest
agc upgrade --tag beta     # @beta, or any dist-tag
```

Automates the three-step upgrade dance the docs used to walk through
by hand: `agc stop --all` → `npm i -g @yc-tech/agent-connect-cli@<tag>`
→ `agc start --daemon` + healthz verification. Detects pre-upgrade
run mode so it only re-launches in daemon mode if the daemon was
running (foreground bots can't be reattached from the upgrade
process's terminal — those are surfaced as "restart it yourself").

The implementation relies on a Unix property: the running process
keeps its old binary file in memory even when npm overwrites the
path, so subsequent invocations naturally pick up the new code
without crashing the upgrader mid-flight.

---

## 0.3.7 — 2026-05-26

### ✨ Changed — directory picker opens at `$HOME`, not `process.cwd()`

When a user binds a topic, the directory picker now starts at the
user's home directory regardless of where the bot daemon was launched
from. Previous behavior used `process.cwd()` — fine for dev users who
ran `pnpm dev` from the repo root (cwd = repo), but unpredictable for
npm-install users: a shell sitting at `~` when running
`agc start --daemon` locked the daemon's cwd at `~` permanently (or
worse, wherever they happened to be); the picker opened there forever.

Home is the stable anchor — every interactive shell falls back to it,
and users descend from a known location into their project tree with
the existing `..` / subdirectory buttons. No env override yet; file
an issue if your workflow needs one.

---

## 0.3.6 — 2026-05-26

### 🐛 Fixed — window picker rendered garbage line on empty windowName / cwd

Reported in the wild from a 0.3.x deployment: a tmux window with empty
`windowName` (or empty `pane_current_path`) rendered as `• \`\` — ` in
the "Bind to Existing Window" picker. Empty backticks don't form a code
entity in our markdown-to-entities converter, so they showed as literal
backticks; the trailing em-dash sat alone with no path. Visible garbage.

- `buildWindowPicker` now substitutes `(unnamed <window_id>)` for empty
  windowName and `(no cwd)` for empty cwd, both in the markdown line AND
  the inline-keyboard button label.
- Backticks inside windowName are now escaped (`` \` ``) — defense in
  depth so a name like `` foo`bar `` can't prematurely close the code
  span and leak the rest as plain markdown.

+2 tests pin both edges (empty fields → fallback labels; embedded
backtick → escaped).

---

## 0.3.5 — 2026-05-26

### 🐛 Fixed — supervisor no longer crash-loops on upgrade

A real user upgraded the npm package while their daemon was still
running, then ran `agc restart`. The old supervisor (loaded in memory
with pre-upgrade code) spawned new-version server children, those
children saw the still-bound port from the lingering runtime.json,
threw, exited code 1, and the supervisor dutifully respawned them.
**8786 crash-restart cycles** before the user manually killed the
supervisor.

The reported "stuck Thinking…" status messages on Telegram turned out
to be downstream of this same loop: Stop hooks fired during the brief
crash windows were dropped (the bot was unreachable for sub-second
gaps repeatedly), and `drainTranscript` persists its offset BEFORE
dispatching, so the missed Stop events never replayed on the next boot.
With the loop broken, those Stop hooks land normally and the Thinking
status clears as designed.

Two layers of defense:

- **Service exits code 2** (instead of throwing → code 1) when it
  detects another agent-connect listening on its port, with stderr
  pointing at `agc stop --all && agc start --daemon`. Code 2 is the
  reserved "explicit bail, don't respawn me" signal between server
  and supervisor.
- **Supervisor treats code 2 as a permanent stop**, refusing to
  respawn and shutting itself down with a clear error. Independent of
  code 2, it also adds a **crash-loop backstop**: 5 unintentional
  exits within 30 s and the supervisor gives up. Catches startup
  crashes that aren't using code 2 (legacy clients, real bugs).

README + CLAUDE.md now recommend `agc stop --all → npm i → agc start
--daemon` as the upgrade procedure. The previous wording (`npm i ...
&& agc restart`) created the in-the-wild incident.

---

## 0.3.4 — 2026-05-26

### 🚨 Critical — 0.3.1 / 0.3.2 / 0.3.3 installs were broken on npm

These three releases shipped with `workspace:*` literals in their npm tarball
`dependencies` field:

```
@yc-tech/agent-connect-cli  →  "@yc-tech/agent-connect-bot": "workspace:*"
@yc-tech/agent-connect-bot  →  "@yc-tech/telegramify-markdown": "workspace:*"
```

The npm registry doesn't understand pnpm's `workspace:` protocol, so
`npm i -g @yc-tech/agent-connect-cli@0.3.x` (1 ≤ x ≤ 3) fails with
`EUNSUPPORTEDPROTOCOL` or similar. Root cause was switching the
release flow from `pnpm publish` (which rewrites `workspace:*` to the
locked version) to plain `npm publish` (which does NOT). 0.3.0 was
correct because it predated that flow change.

This release is identical to 0.3.3 in functionality. The fix is purely
on the publish path:

- Versions republished via `pnpm publish` from each package directory,
  so `workspace:*` is rewritten to an exact version pin
  (`"@yc-tech/agent-connect-bot": "0.3.4"`,
  `"@yc-tech/telegramify-markdown": "0.1.1"`).
- 0.3.1, 0.3.2, 0.3.3 of both packages are deprecated on npm with a
  pointer to 0.3.4.

**Upgrade**: `npm i -g @yc-tech/agent-connect-cli@latest` (or `@^0.3.4`).
If you were on 0.3.0, you can skip 0.3.1–0.3.3 directly.

### 📋 Recap — what 0.3.1 → 0.3.3 contained (now actually usable)

For users coming straight from 0.3.0, this release rolls up everything
those broken releases were trying to deliver:

- **0.3.1**: Plan-A tmux outage durability (DB preserved across tmux
  death); soft-delete `thread_bindings` with FK SET NULL + new
  `last_session_id` recovery anchor; `/join` resume picker
  default-highlights the previous session.
- **0.3.2**: Subscribe to Claude's `StopFailure` hook (surfaces
  rate_limit / server_error / billing_error etc. to Telegram + clears
  stuck spinner text); `/resume` slash command + recovery-aware
  fallback in `forwardCommandHandler`.
- **0.3.3**: `parseStatusLine` now anchors on the upper chrome when
  the TUI sandwiches input between two separators (fixed
  "Manifesting…" status getting stuck); `agc send` resolves
  `windowId` via `$TMUX_PANE` instead of tmux's currently-active
  window.

See the per-version sections below for details. Schema migrations all
still apply on first launch.

---

## 0.3.3 — 2026-05-25

### 🐛 Fixed — `parseStatusLine` anchored on the wrong chrome when input was sandwiched

Claude's TUI now wraps the input row with chrome separators on BOTH sides:

```
✻ Worked for 36s              ← spinner status (above)
● How is Claude doing...      ← rating prompt (skip)
─────────────────────────     ← chrome 1 (above input)
❯ commit 这些改动              ← user input echo
─────────────────────────     ← chrome 2 (below input)
  ⏵⏵ bypass permissions ...   ← footer mode bar
```

`searchStart = lines.length - 10` only saw chrome 2. Walking back from chrome 2
hit the `❯` input arrow on the first step, terminated, returned null. Telegram
stayed stuck on the previous spinner text (live-reported as "Manifesting…
(35s · ↑ 321 tokens · thinking more)" lingering for minutes after Claude had
actually finished). Widened search to last 15 lines and anchored on the FIRST
chrome found (= upper one in pane order); walk-back now sees the spinner
naturally. +1 test pinning the four-piece chrome/input/chrome/footer layout.

### 🐛 Fixed — `agc send` resolved the wrong window when called via Bash tool

`agc send /path/to/file` ran `tmux display-message -p "#{window_id}"` without
`-t`, which returns tmux's currently-active window (the user's foreground
view), not the window of the pane that exec'd the CLI. So a Claude running in
window `@4` could see `@0` and report "no Telegram topic is bound to window
@0" even when @4 was bound. Now uses `$TMUX_PANE` (set by tmux on every child
process) as the explicit `-t` target so the lookup always reflects the
calling pane. `agc hook` was already correct.

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
