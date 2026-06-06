# @yc-tech/agent-connect-bot

Telegram bot, Fastify management API, hook router, and SQLite-backed runtime state for [Agent Connect](https://github.com/yc-technology/agent-connect).

This package ships both:

- The full service (used internally by [`@yc-tech/agent-connect-cli`](https://www.npmjs.com/package/@yc-tech/agent-connect-cli) — most users want the CLI, not this package directly).
- A small library surface for advanced embedding scenarios.

## Library exports

```ts
import { runHookClient } from "@yc-tech/agent-connect-bot/hookClient";
import { installAllHooks } from "@yc-tech/agent-connect-bot/hookInstaller";
import { runBotService } from "@yc-tech/agent-connect-bot/service";
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

- Node.js >= 22.5 (SQLite is the built-in `node:sqlite`, so there's no native
  SQLite addon to compile or keep ABI-matched across Node upgrades)
- `tmux` available on `$PATH`
- Native deps: `sharp` (image handling)

## License

MIT — see [LICENSE](./LICENSE).
