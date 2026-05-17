# Agent Connect

[English README](README.md)
[中文文档](README_CN.md)

Agent Connect управляет локальными сессиями Claude Code или Codex через Telegram. Агент
остается в tmux-окне на вашей машине, а Agent Connect читает вывод и отправляет
сообщения обратно в тот же терминал.

## Возможности

- Один Telegram Forum topic соответствует одному tmux-окну.
- Multi-bot конфигурация хранится в SQLite и управляется через React-консоль.
- Поддержка Claude Code и Codex с автоматической синхронизацией hooks.
- По умолчанию отправляются временный статус `Thinking...` и финальный ответ; промежуточные tool/status сообщения включаются в настройках.
- Браузер директорий, resume сессий, история, скриншоты и forwarding slash-команд.
- Форматирование Telegram HTML через workspace-пакет `@agent-connect/telegramify-markdown`.

## Требования

- Node.js 22+
- pnpm 10.6.3+
- tmux
- `claude` или `codex` доступны в PATH

## Запуск

```bash
pnpm install
pnpm dev
```

`pnpm dev` запускает:

- Bot/API service: `127.0.0.1:8787`
- Web console: `127.0.0.1:5173`

Основные команды:

```bash
pnpm dev:bot       # только bot/API
pnpm dev:web       # только web console
pnpm start         # compiled CLI service
pnpm hook:install  # синхронизация Claude и Codex hooks
pnpm typecheck
pnpm build
pnpm test:ts
```

Global link:

```bash
pnpm --filter agent-connect build
cd packages/cli
pnpm link --global
agc help
```

После link команда `agc` указывает на TypeScript CLI.

Для npm-дистрибуции опубликуйте workspace packages и установите CLI:

```bash
pnpm -r publish
npm install -g agent-connect
```

## Telegram Setup

1. Создайте bot через [@BotFather](https://t.me/BotFather) и получите token.
2. Откройте mini app в профиле @BotFather.
3. Выберите bot, затем **Settings** > **Bot Settings**.
4. Включите **Threaded Mode**.
5. Запустите `pnpm dev`, откройте `http://127.0.0.1:5173` и добавьте bot config.

`ALLOWED_USERS` принимает числовые Telegram user IDs, не номера телефонов.

## Конфигурация

Runtime читает `.env` из корня репозитория и `$AGENT_CONNECT_DIR/.env`.

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `AGENT_CONNECT_DIR` | `~/.agent-connect` | Каталог конфигурации и состояния |
| `AGENT_CONNECT_DB_FILE` | `$AGENT_CONNECT_DIR/agent-connect.sqlite` | Путь к SQLite DB |
| `AGENT_CONNECT_TS_ENABLE_TELEGRAM` | `true` | Запуск включенных bot runtimes |
| `TMUX_SESSION_NAME` | `agent-connect` | Имя tmux session |
| `CLAUDE_COMMAND` | `claude --permission-mode bypassPermissions` | Команда запуска Claude |
| `CODEX_COMMAND` | `codex --yolo` | Команда запуска Codex |
| `MONITOR_POLL_INTERVAL` | `2.0` | Интервал polling transcript |
| `AGENT_CONNECT_TOPIC_PROBE_INTERVAL` | `60.0` | Probe удаленных topics; `0` отключает |
| `AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES` | `false` | Отправлять промежуточные tool/status сообщения |
| `AGENT_CONNECT_SHOW_HIDDEN_DIRS` | `false` | Показывать hidden directories |
| `OPENAI_API_KEY` | none | API key для voice transcription |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI API base URL |

## Hooks

Hooks синхронизируются при старте. Ручной repair:

```bash
agc hook --install
```

Generated hook command:

```text
agc hook
```

If a hook process does not inherit your shell `PATH`, override it before
installing hooks, for example
`AGENT_CONNECT_HOOK_COMMAND=/absolute/path/to/agc agc hook --install`.

## Workspace Layout

```text
apps/bot/                       TypeScript bot runtime and Fastify API
apps/web/                       React + Vite + Zustand management console
packages/cli/                   `agc` command line entrypoint
packages/telegramify-markdown/  `@agent-connect/telegramify-markdown` formatting package
doc/                            Project notes
scripts/                        Local operations
```
