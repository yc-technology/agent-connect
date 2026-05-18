# @yc-tech/agent-connect-cli

Command-line entrypoint for [Agent Connect](https://github.com/yc-technology/agent-connect) — control Claude Code or Codex sessions remotely from Telegram through tmux.

Each Telegram Forum topic maps to one tmux window and one agent session. Claude Code and Codex hooks POST events to a local Fastify service so the bot stays event-driven (no transcript polling).

## Install

```bash
npm install -g @yc-tech/agent-connect-cli
```

Provides the `agc` binary.

## Quick start

```bash
# Install Claude Code + Codex hooks so they POST events to the bot
agc hook --install

# Start the bot service + management API + web console
agc start
```

The management console runs at `http://127.0.0.1:5173`; add your Telegram bot token and start binding topics.

## Requirements

- Node.js >= 22
- `tmux` available on `$PATH`
- A Telegram bot with **Threaded Mode** enabled (set via [@BotFather](https://t.me/BotFather))
- [Claude Code](https://docs.claude.com/claude-code) and/or [Codex](https://github.com/openai/codex) installed locally if you want to drive them

## Docs

See the [main README](https://github.com/yc-technology/agent-connect#readme) for architecture, configuration, topic mapping, message queue behavior, and the management console screens.

## License

MIT — see [LICENSE](./LICENSE).
