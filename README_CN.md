# Agent Connect

[English README](README.md)
[Русская документация](README_RU.md)

Agent Connect 通过 Telegram 远程控制本地 tmux 里的 Claude Code 或 Codex 会话。Agent 仍然运行在你的终端里，Agent Connect 只负责读取输出并把 Telegram 消息发送回同一个 tmux 窗口。

## 功能

- Telegram Forum 话题和 tmux 窗口一一绑定。
- SQLite 存储多 Bot 配置，并提供 React 管理页面。
- 支持 Claude Code 和 Codex，启动时自动同步 hooks。
- 默认只发送 `Thinking...` 临时状态和最终回答，可在设置中开启中间 tool/status 消息。
- 支持目录浏览、恢复会话、历史记录、截图和 slash command 转发。
- 使用 workspace 内的 `@agent-connect/telegramify-markdown` 转换 Telegram HTML。

## 要求

- Node.js 22+
- pnpm 10.6.3+
- tmux
- `claude` 或 `codex` 命令已在 PATH 中

## 启动

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会启动：

- Bot/API 服务：`127.0.0.1:8787`
- 管理页面：`127.0.0.1:5173`

常用命令：

```bash
pnpm dev:bot       # 只启动 bot/API
pnpm dev:web       # 只启动管理页面
pnpm start         # 运行编译后的 CLI 服务
pnpm hook:install  # 同步 Claude 和 Codex hooks
pnpm typecheck
pnpm build
pnpm test:ts
```

全局 link：

```bash
pnpm --filter agent-connect build
cd packages/cli
pnpm link --global
agc help
```

link 后，`agc` 指向 TypeScript CLI。

npm 发布后可以直接安装 CLI：

```bash
pnpm -r publish
npm install -g @agent-connect/cli
```

## Telegram 设置

1. 找 [@BotFather](https://t.me/BotFather) 创建 bot 并获取 token。
2. 打开 @BotFather 的个人页面，进入 mini app。
3. 选择 bot，进入 **Settings** > **Bot Settings**。
4. 开启 **Threaded Mode**。
5. 启动 `pnpm dev`，打开 `http://127.0.0.1:5173` 添加 bot 配置。

`ALLOWED_USERS` 填 Telegram 数字用户 ID，不是手机号。

## 配置

运行时会读取仓库根目录 `.env` 和 `$AGENT_CONNECT_DIR/.env`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_CONNECT_DIR` | `~/.agent-connect` | 配置和状态目录 |
| `AGENT_CONNECT_DB_FILE` | `$AGENT_CONNECT_DIR/agent-connect.sqlite` | SQLite 数据库路径 |
| `AGENT_CONNECT_TS_ENABLE_TELEGRAM` | `true` | 启动已启用的 bot runtime |
| `TMUX_SESSION_NAME` | `agent-connect` | 默认 tmux session 名称 |
| `CLAUDE_COMMAND` | `claude --permission-mode bypassPermissions` | Claude 启动命令 |
| `CODEX_COMMAND` | `codex --yolo` | Codex 启动命令 |
| `MONITOR_POLL_INTERVAL` | `2.0` | transcript 轮询间隔 |
| `AGENT_CONNECT_TOPIC_PROBE_INTERVAL` | `60.0` | 已删除 topic 探测间隔，`0` 关闭 |
| `AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES` | `false` | 是否发送完整中间 tool/status 消息 |
| `AGENT_CONNECT_SHOW_HIDDEN_DIRS` | `false` | 目录浏览器是否显示隐藏目录 |
| `OPENAI_API_KEY` | 无 | 语音转文字 API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI API 地址 |

## Hooks

启动时会同步 Claude 和 Codex hooks。手动修复：

```bash
agc hook --install
```

生成的 hook 命令是：

```text
agc hook
```

如果 hook 进程没有继承 shell 里的 `PATH`，可以在安装 hook 前显式覆盖：
`AGENT_CONNECT_HOOK_COMMAND=/absolute/path/to/agc agc hook --install`。

## 目录结构

```text
apps/bot/                       TypeScript bot runtime 和 Fastify API
apps/web/                       React + Vite + Zustand 管理页面
packages/cli/                   `agc` 命令行入口
packages/telegramify-markdown/  `@agent-connect/telegramify-markdown` 格式化包
doc/                            项目说明
scripts/                        本地运维脚本
```
