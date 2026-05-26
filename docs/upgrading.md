# Upgrading agent-connect

**TL;DR**:

```bash
agc stop --all
npm i -g @yc-tech/agent-connect-cli@latest
agc start --daemon
```

Do NOT just `npm i -g @yc-tech/agent-connect-cli@latest && agc restart` — see
[Why `agc restart` alone is wrong](#why-agc-restart-alone-is-wrong).

---

## Why `agc restart` alone is wrong

Earlier README versions told users that `npm i ... && agc restart` was the
clean upgrade path. **It isn't.** This is the issue that produced the
8786-cycle crash-restart loop a real user reported on 2026-05-26.

Mechanism:

1. `npm i -g @yc-tech/agent-connect-cli@latest` overwrites the binaries on
   disk but does NOT touch the running daemon.
2. The old daemon's supervisor process is still in memory with code from
   the previous version.
3. `agc restart` sends SIGUSR2 to that old supervisor. The old supervisor
   kills its child and spawns a NEW child — but spawns it via the
   on-disk script path, which now points at the **new** version's code.
4. The version-mismatched child can hit startup constraints the old
   supervisor doesn't satisfy (stale `runtime.json` pointing to a port
   still bound by something, schema differences between supervisor and
   server, etc.) → child exits non-zero.
5. Old supervisor sees unexpected exit → respawn → same crash → respawn
   forever.

0.3.5+ adds two backstops (code-2 explicit bail, and a 5-exits-in-30s
crash-loop guard) so the loop trips out after a few seconds instead of
running for hours. But the cleanest path is still: stop the daemon
first, then upgrade, then start it back up. That way there's no
version-mismatched process anywhere.

## Step-by-step

### 1. Stop the running daemon

```bash
agc stop --all
```

`--all` kills any agc process (supervisor + server children) that's
holding `~/.agent-connect/runtime.json` or `~/.agent-connect/supervisor.json`.
Without `--all`, the stop command is more conservative and might leave
a foreground process running in parallel.

Verify nothing's left:

```bash
ps -ax | grep '[a]gc' || echo "no agc processes"
ls ~/.agent-connect/runtime.json ~/.agent-connect/supervisor.json 2>&1
```

Both JSON files should be gone (or about to be — they're removed on
clean shutdown).

If something is stuck:

```bash
pkill -f 'agent-connect.*start\|agent-connect.*supervise'
rm -f ~/.agent-connect/runtime.json ~/.agent-connect/supervisor.json
```

### 2. Upgrade the npm package

```bash
npm i -g @yc-tech/agent-connect-cli@latest
```

Verify the installed version:

```bash
agc --version 2>/dev/null || npm ls -g @yc-tech/agent-connect-cli
```

### 3. Start the daemon fresh

```bash
agc start --daemon
```

Verify it came up healthy:

```bash
agc status
```

Should show "alive", a recent `lastHealthCheckAt`, and the new version's
PID.

---

## Symptoms and which version fixes them

If you're seeing any of these, check what version you're on. Anything
< 0.3.5 has known bugs that have since been fixed.

| Symptom | Root cause | Fixed in |
|---|---|---|
| `npm i -g @yc-tech/agent-connect-cli@0.3.1` (or 0.3.2 / 0.3.3) fails with `EUNSUPPORTEDPROTOCOL` | tarballs contained `workspace:*` literally because they were published via `npm publish` instead of `pnpm publish`; npm registry can't resolve `workspace:` URLs | 0.3.4 (republished through `pnpm publish`); 0.3.1–0.3.3 are deprecated on npm |
| daemon crash-restart loops 8000+ times after upgrading | old supervisor + new child code mismatch (and a stale runtime.json holding the port) | 0.3.5 (code-2 explicit bail + 5-exits-in-30s backstop) |
| Telegram status stuck on "Thinking…" for minutes even though Claude finished | Stop hook events dropped during the crash-restart window; `drainTranscript` persists offset before dispatch so they don't replay | 0.3.5 (root cause was the crash loop; with that fixed, Stop hooks land normally) |
| Telegram status stuck on `Compacting conversation… 1%` after a `/compact` failure | bot didn't subscribe to Claude's `StopFailure` hook; turn-level API errors (rate_limit, server_error, billing_error, …) were silently dropped | 0.3.2 (subscribe + handle StopFailure → surface error and overwrite stale spinner) |
| topic binding silently lost after a `tmux kill-server` / OS restart | old `tmuxManager.listWindows` returned `[]` on any tmux exec failure, so statusPolling cleanup mistook a transient outage for "every window gone" and FK CASCADE wiped the entire DB | 0.3.1 (`listWindowsAuthoritative` distinguishes unreachable from empty; soft-delete keeps the binding + `last_session_id` recovery anchor) |
| `/join` resume picker shows the prior session but doesn't visually mark which one to pick | recovery anchor wasn't fed to the picker | 0.3.1 (★ + "(previous)" tag on the matching row) |
| `parseStatusLine` returns nothing even though the pane has a spinner | the TUI sandwiches input between TWO chrome separators now (chrome/input/chrome/footer), and the old 10-line search window only saw the lower chrome, hitting `❯` immediately and breaking | 0.3.3 |
| `agc send <file>` reports "no Telegram topic is bound to window @0" even though the current pane IS bound | `tmux display-message -p '#{window_id}'` without `-t` returns the client's currently-active window, not the calling pane's window | 0.3.3 (use `$TMUX_PANE` as explicit `-t`) |
| Window picker shows `• \`\` — ` garbage row | empty `windowName` + empty `cwd` from tmux, no fallback in `buildWindowPicker` | 0.3.6 |

If you upgrade to the latest and a symptom persists, it's a fresh bug —
file it with logs from `agc logs` rather than assuming it's residual
old-version behavior.

---

## Verifying after upgrade

Quick smoke test that everything reconnected:

1. `agc status` shows daemon alive on the expected version.
2. Send any message in a bound Telegram topic — the round trip works (you
   see "Thinking…" briefly, then Claude's response).
3. If you had bindings before the upgrade, they should still be there:
   ```bash
   sqlite3 ~/.agent-connect/bots/*/bot.sqlite \
     "SELECT thread_id, window_id, recovery_pending FROM thread_bindings;"
   ```
   `recovery_pending = 1` rows mean "binding survived but window vanished —
   send any text message in the topic to re-attach and pick the prior
   session from the resume picker (it'll be ★-marked)".

---

## What about downgrading?

`npm i -g @yc-tech/agent-connect-cli@0.3.5` works in either direction; the
SQLite schema migrations are forward-compatible only in newer versions
adding columns (`last_session_id`, `recovery_pending`). Downgrading
from 0.3.1+ to 0.3.0 is **not supported** — the older code doesn't
know about the new columns / FK shape. If you must roll back further,
back up `~/.agent-connect/bots/*/bot.sqlite` first.
