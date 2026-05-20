---
name: agc-send-file
description: Use when the user asks to "send me a file", "give me the zip", "share the build artifact", "drop me the log", or any similar request to deliver a local file to them (zip, pdf, log, screenshot, build output, etc.). Runs `agc send <path>` which uploads the file via the Agent Connect bot to the Telegram topic bound to the current tmux window — no compression, real filename preserved, 50 MB cap.
metadata:
  short-description: Deliver a local file to the user via Telegram (zip / pdf / log / build / etc.)
---

# agc send — deliver a local file to the user

The user is talking to you through a Telegram topic that's bridged to this
tmux window by the Agent Connect bot. The agent protocol's `tool_result`
content only supports text + image blocks, so you cannot return a zip /
pdf / log file inside a tool response. Instead, run `agc send <path>` in
the shell — the bot uploads the file via Telegram's `sendDocument`
(uncompressed, original quality, real filename) into the same topic.

## When to use this skill

Use whenever the user asks for a file artifact, e.g.:

- "send me the build zip"
- "give me that pdf"
- "drop the log file here"
- "share the screenshot"
- "I want the dump you just produced"

Or when you've produced a file the user clearly needs (a generated report,
a build output, a packaged archive) and there's no in-conversation way to
hand it over.

Don't use it for:

- Short text content (paste it directly into the response)
- Code snippets (use a code block)
- A simple file *listing* (text is fine)

## How to call it

```bash
agc send <absolute-or-relative-path>
agc send <path> --caption "optional caption (≤1024 chars)"
```

Examples:

```bash
agc send /tmp/build.zip
agc send ./dist/report.pdf --caption "Q2 numbers, draft"
agc send /var/log/app.log --caption "last hour of logs"
```

Default caption is `📎 <basename> (<size>)`. Override with `--caption`
when extra context helps the user.

## Constraints

- **Must run inside the same tmux pane** as your agent session. `agc send`
  uses `tmux display-message` to discover which Telegram topic to target;
  outside tmux it errors with "must run inside a tmux pane".
- **50 MB hard cap** (Telegram's `sendDocument` limit). Larger files are
  rejected with HTTP 413; split or compress first.
- **No directories**: pass a single file path. Zip the directory first if
  you need to send one (`zip -r out.zip dir/ && agc send out.zip`).
- **Empty files** are rejected (Telegram refuses 0-byte documents).
- The bot service must be running. If `agc send` reports
  "bot service is not running", tell the user — don't try to start it
  yourself.

## What happens on the user's end

The file appears as a normal Telegram document in the topic, with your
caption (or the default `📎 …` one). Common file types (zip, pdf, png,
jpg, log, txt, json, mp4, …) get the right MIME so the Telegram client
renders the proper icon / preview. Unknown extensions fall back to
`application/octet-stream` — the file still arrives, just with a generic
"file" icon.

## Output to expect

Success:

```text
sent build.zip (1234567 bytes) to 1 chat(s) via cc-dog:@9
```

If a delivery partially fails (e.g. Telegram rate limit on one topic
when the window is bound to multiple users), you'll also see:

```text
warning: 1 delivery attempt(s) failed (see ~/.agent-connect/logs/current.log)
```

Exit code is still 0 in that case (at least one delivery succeeded).
Full failure exits 1.
