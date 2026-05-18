# @agent-connect/bot

Telegram bot, Fastify management API, hook router, and SQLite-backed runtime state for [Agent Connect](https://github.com/yc-technology/agent-connect).

This package ships both:

- The full service (used internally by [`@agent-connect/cli`](https://www.npmjs.com/package/@agent-connect/cli) — most users want the CLI, not this package directly).
- A small library surface for advanced embedding scenarios.

## Library exports

```ts
import { runHookClient } from "@agent-connect/bot/hookClient";
import { installHooks } from "@agent-connect/bot/hookInstaller";
import { startService } from "@agent-connect/bot/service";
```

| Export | Purpose |
|---|---|
| `.` | High-level entry (`main`) used by the CLI. |
| `./hookClient` | Reads a Claude/Codex hook payload from stdin and POSTs it to a running bot. |
| `./hookInstaller` | Writes `~/.claude/settings.json` and `~/.codex/hooks.json` so agents fire `agc hook` per event. |
| `./service` | Starts the Fastify server, multi-bot runtime, SessionRegistry, HookRouter. |

## Architecture

```text
Telegram Forum Topic
  → thread_bindings (SQLite)
  → tmux window ID
  → Claude / Codex session
  → agent hook → POST /hook/events
  → HookRouter (per-window queue)
  → drainTranscript (per-session lock, reads transcript from offset)
  → MessageQueueManager → Telegram
```

See the [main README](https://github.com/yc-technology/agent-connect#readme) for the full design.

## Requirements

- Node.js >= 22
- `tmux` available on `$PATH`
- Native deps: `better-sqlite3` (prebuilt binaries for most platforms) and `sharp`

## License

MIT — see [LICENSE](./LICENSE).
