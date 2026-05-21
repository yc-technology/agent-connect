---
name: agent-connect-setup
description: Use when the user asks to "set up agent-connect", "configure agent-connect", "I just installed @yc-tech/agent-connect-cli", "agc start doesn't work", "help me wire up the Telegram bot", "agent-connect 怎么配置", "我刚装了 agc", or any similar setup / debug request for the Agent Connect Telegram bridge. Walks the user through bot-token creation, env config, daemon start, hook install, and the first end-to-end message test. Also covers the common failure modes (no token, wrong PATH for hooks, missing tmux, bot not in group, threaded-mode off) with the exact log greps that confirm each.
---

# Agent Connect — setup & debug walkthrough

You're helping the user wire up the Agent Connect Telegram bridge. The
package is `@yc-tech/agent-connect-cli`, installed globally (`npm i -g
@yc-tech/agent-connect-cli`). The CLI binary is `agc`. The bot bridges
**Telegram Forum topics ↔ tmux windows ↔ Claude Code / Codex sessions**.

## How to use this skill

Walk the user through the steps **one at a time**, waiting for them to
confirm each before moving on. Don't dump the whole guide at once. After
each command you run, check the output and tell them what's good/bad.

Skip steps the user already completed (e.g. if `agc status` shows the
daemon is healthy, jump straight to "first message test").

---

## Prerequisites — check first

```bash
node --version    # need >= 22
which tmux        # need tmux on PATH
which agc         # confirms @yc-tech/agent-connect-cli is installed
which claude      # optional but expected if they want Claude Code
which codex       # optional but expected if they want Codex
```

If any of these fail, stop and tell the user what to install:
- Node 22+: nvm / homebrew / nodejs.org
- tmux: `brew install tmux` (macOS) / `apt install tmux` (Debian) / `pacman -S tmux` (Arch)
- agc: `npm i -g @yc-tech/agent-connect-cli`
- claude: https://docs.claude.com/claude-code
- codex: https://github.com/openai/codex

---

## Step 1 — Create the Telegram bot

The user needs a bot token. Walk them through:

1. Open https://t.me/BotFather in Telegram
2. `/newbot` → answer name + username prompts → BotFather replies with
   a token like `1234567890:ABCdefGHIjklmnoPQRstuVWXYZ...`
3. **Crucial**: on the same BotFather, open the bot's mini-app via the
   profile page → **Settings → Bot Settings → Threaded Mode → Enable**.
   Without this, Forum topics can't be created. The bot will *appear*
   to work but every "create new topic" attempt silently fails.

Ask the user for the bot token. **Do not log it.** Store it in
`~/.agent-connect/.env`:

```bash
mkdir -p ~/.agent-connect
cat >> ~/.agent-connect/.env <<'EOF'
TELEGRAM_BOT_TOKEN=<token from BotFather>
EOF
chmod 600 ~/.agent-connect/.env
```

---

## Step 2 — Restrict who can talk to the bot

Without `TELEGRAM_ALLOWED_USERS`, the bot accepts messages from anyone
who finds it. Get the user's Telegram numeric ID:

- Easiest: have them DM https://t.me/userinfobot — it replies with their
  numeric ID (e.g. `6320786036`).
- Or: search for `@userinfobot` in any chat.

Add to `~/.agent-connect/.env`:

```bash
TELEGRAM_ALLOWED_USERS=6320786036
# Multiple users: comma-separated, no spaces
# TELEGRAM_ALLOWED_USERS=6320786036,1234567890
```

---

## Step 3 — Create the Telegram group + enable topics

1. Telegram → New Group → add the bot as a member
2. Group settings → **Topics → Enable**
3. Promote the bot to **admin** of the group (it needs "Manage Topics"
   permission to create / close topics from the directory browser)

The user does NOT need to send any message yet — that comes after the
daemon is up.

---

## Step 4 — Start the daemon

```bash
agc start --daemon
sleep 2
agc status
```

Expected `agc status` output:

```
agc supervisor:
  pid:           <some pid> (alive)
  server pid:    <some pid>
  listening:     127.0.0.1:17666
  uptime:        Xs
  restart count: 0
  live healthz:  200 ✓
```

If `live healthz` is NOT 200:

- Port already in use (RStudio Server, another agc): `lsof -i :17666` to
  see who owns it. Set `AGENT_CONNECT_HTTP_PORT=17777` in `.env` and
  `agc stop && agc start --daemon`.
- No `TELEGRAM_BOT_TOKEN`: check `~/.agent-connect/.env` exists with the
  right key name (NOT `BOT_TOKEN` or `TELEGRAM_TOKEN`).
- Crash on startup: `agc logs` to see the error, scroll back ~50 lines.

---

## Step 5 — Install Claude / Codex hooks

```bash
agc hook --install
```

Should print:
```
Claude: Hook synchronized in /Users/.../.claude/settings.json
Codex: Codex hook synchronized in /Users/.../.codex/hooks.json
```

If you see "Hook already synchronized" — that's fine, idempotent.

**Common gotcha**: Claude Code / Codex spawn the hook process from the
shell PATH that was active when they STARTED. If `agc` isn't on the
PATH of an existing Claude/Codex process, hooks silently fail (the
agent gives no error; the bot just never sees events). Fix: have the
user **restart Claude Code / Codex** in any tmux window before
expecting hooks to work. To verify on an existing process:

```bash
# Find the Claude pid in the relevant tmux window
tmux display-message -t <session>:<window> -p '#{pane_pid}' | xargs pgrep -P
# Get its PATH (macOS)
ps -E -p <claude-pid> | tr ' ' '\n' | grep '^PATH=' | tr ':' '\n' | grep -E 'agc|node'
```

If `agc`'s install directory isn't in that PATH, the user must restart
Claude / Codex.

---

## Step 6 — First end-to-end message test

1. User opens their Telegram group
2. Creates a new topic (any name, e.g. "test")
3. Sends any message, e.g. `hi`
4. The bot should reply with a **directory browser** ("Where should I
   start the agent? Pick a directory below.")
5. Pick a directory → bot launches a tmux window + Claude/Codex session
   → the agent starts up, the topic name updates

Verify on the host:

```bash
tmux list-windows -a              # should show a new window
agc logs | tail -50               # confirm message flow
```

### If nothing happens in TG after the user sends `hi`:

Open a tail in another shell:

```bash
tail -f ~/.agent-connect/logs/agent-connect.$(date +%Y-%m-%d).1.log
```

(Note: `current.log` symlink can lag behind the real file after midnight
rotation. Always grep the dated `.1.log` to be safe.)

Have the user send a message in TG. You should see lines about:
- `incoming request` on `/bot/...` (bot received TG webhook)
- `directoryBrowser` (offered the picker)

If you see NOTHING:
- Network: Telegram unreachable. Check `HTTP_PROXY` if behind GFW; add
  it to `~/.agent-connect/.env` and `agc restart`.
- Wrong token: BotFather can `/revoke` and reissue, paste into `.env`,
  `agc restart`.
- User not in `TELEGRAM_ALLOWED_USERS`: bot ignores. Check via
  `userinfobot` again, the ID might have a leading minus for groups.

### If the directory browser appears but picking does nothing:

- Bot is not group admin → can't update topic name. Symptom: tmux window
  starts but TG topic stays "test". Fix in group settings.
- tmux not on PATH for the bot daemon. Check `which tmux` in the shell
  where `agc start --daemon` was launched.

---

## Step 7 — Verify Claude / Codex can talk back

In any tmux window the bot spawned, the agent should be running. Type
something. Expected on the TG side:

- A `Thinking…` status appears (overwrites in place — same TG message)
- The status updates to live spinner text like `Hashing… (3m 21s ↓ 9.1k
  tokens)` (the StatusPoller harvests Claude's TUI spinner every 1s)
- Final answer arrives as a normal TG message with markdown formatted as
  HTML

If you see `Thinking…` STUCK forever (live spinner never updates):
- Probably a Claude TUI glyph parsing edge case (it changes occasionally).
  Grep recent log lines for the window: `grep '"windowId":"@N"'
  ~/.agent-connect/logs/agent-connect.*.log | tail -20`
- Workaround until upstream fix: the final answer still arrives, just
  no live progress

If you see NOTHING at all on the TG side (not even Thinking):
- The hook isn't firing. Re-check Step 5. Try `agc hook --install`
  again. Restart the Claude / Codex process.

---

## Operational commands the user should know

```bash
agc status              # daemon health
agc logs                # tail (symlink may be stale after midnight; see Step 6)
agc restart             # reload the server child without losing supervisor
agc stop                # graceful shutdown
agc send /tmp/file.zip  # send a local file to the bound topic (50 MB cap)
```

The web admin console is at **http://127.0.0.1:17666/** (port = whatever
`AGENT_CONNECT_HTTP_PORT` is set to). Use it to add a second bot,
toggle per-bot settings, or browse active sessions.

---

## Where things live

- Config + env: `~/.agent-connect/.env`
- SQLite DBs: `~/.agent-connect/agent-connect.sqlite` (bots) and
  `~/.agent-connect/bots/<id>/bot.sqlite` (per-bot state)
- Logs: `~/.agent-connect/logs/agent-connect.<date>.<n>.log` (daily
  rotate, 30-file retention)
- Daemon state: `~/.agent-connect/supervisor.json` (alive only when
  daemon is running)

Don't edit the SQLite files directly while the daemon is up — use the
web console or `agc` commands.

---

## When you're stuck

Get the user to share:

1. `agc status` output
2. `agc --version` (or `cat $(npm root -g)/@yc-tech/agent-connect-cli/package.json | grep version`)
3. Last 100 lines of today's log: `tail -100 ~/.agent-connect/logs/agent-connect.$(date +%Y-%m-%d).1.log`
4. What they see in Telegram vs what they expected

If the daemon won't even start, redirect them to file an issue at
https://github.com/yc-technology/agent-connect/issues with those four
artifacts attached.
