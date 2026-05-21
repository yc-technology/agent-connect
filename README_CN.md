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
- 使用 workspace 内的 `@yc-tech/telegramify-markdown` 转换 Telegram HTML。

## 要求

- Node.js 22+
- pnpm 10.6.3+（只在 monorepo 开发时需要，`npm i -g` 不需要）
- tmux
- `claude` 或 `codex` 命令已在 PATH 中

## 快速开始（npm 安装）

刚 `npm i -g @yc-tech/agent-connect-cli` 完按顺序走。也可以把这一节直
接发给你的 Claude / Codex 让它带你做。

### 1. 创建 Telegram bot

1. 打开 [@BotFather](https://t.me/BotFather)，`/newbot`，跟着提示走
   —— 复制返回的 token（`1234567890:AB...`）。
2. **重要**：在 BotFather 的 profile 打开 bot 的 mini-app →
   **Settings → Bot Settings → Threaded Mode → Enable**。不开后面创建
   topic 会静默失败。

### 2. 配置环境变量

```bash
mkdir -p ~/.agent-connect
cat >> ~/.agent-connect/.env <<EOF
TELEGRAM_BOT_TOKEN=<粘贴你的 token>
TELEGRAM_ALLOWED_USERS=<你的 Telegram 数字 id>
EOF
chmod 600 ~/.agent-connect/.env
```

数字 id：DM [@userinfobot](https://t.me/userinfobot) 即可。多人逗号
分隔不要空格。**不配 `TELEGRAM_ALLOWED_USERS` 任何找到 bot 的人都
能跟它说话。**

### 3. 启动 daemon + 安装 hook

```bash
agc start --daemon       # 后台 spawn supervisor + server
agc status               # 应该看到 "live healthz: 200 ✓"
agc hook --install       # 接通 Claude Code + Codex 的 hook
```

如果 `agc status` 显示 `live healthz: ✗`：

- 端口被占：`lsof -i :17666` 看谁占了。`.env` 加
  `AGENT_CONNECT_HTTP_PORT=17777`，`agc stop && agc start --daemon`。
- token 没配：再查 `~/.agent-connect/.env`（变量名必须是
  `TELEGRAM_BOT_TOKEN`）。
- crash：`agc logs` 往上翻 50 行。

### 4. 建群 + 首条消息

1. Telegram → 新建群 → 加 bot 进群 → 群设置开 **Topics** → 把 bot
   设为 **admin**，并给"管理话题"权限。
2. 创建一个 topic（随便起名），发任意消息（比如 `hi`）。
3. Bot 回一个目录浏览器。选目录 → 它会在那里起一个 tmux window +
   Claude/Codex 会话。
4. 之后这个 topic 的消息都路由到那个 agent，输出（status spinner、
   中间动作、最终答案）实时流回 TG。

### 常见坑

| 现象 | 原因 | 修 |
| --- | --- | --- |
| Bot 完全不回 | 你的 id 不在 `TELEGRAM_ALLOWED_USERS` 里 | DM @userinfobot 再确认 |
| 目录浏览器出来了但选了没反应 | Bot 不是群管理员 | 群设置把 bot 设管理员 |
| Topic 一直叫 "New Topic" | Bot 没有"管理话题"权限 | 同上，admin + Manage Topics |
| Claude/Codex 在跑但 TG 看不到 `Thinking…` | Hook 没 fire，因为 `agc` 不在 agent 进程的 PATH 里 | 重启 Claude / Codex；持续就 `AGENT_CONNECT_HOOK_COMMAND=/绝对路径/agc agc hook --install` |
| `agc status` 重启后显示 `unreachable` | daemon crash 了 | `agc logs` 看最后 50 行 |

### 跑起来后常用命令

```bash
agc status                  # uptime / restart count / healthz
agc logs                    # tail 今天的日志
agc restart                 # 重载 server 代码（supervisor 不动）
agc stop                    # 优雅 shutdown
agc send /tmp/foo.zip       # 把本地文件（≤50MB）发到当前 tmux
                            # window 绑定的 topic
```

Web 管理控制台：**http://127.0.0.1:17666/**（端口跟
`AGENT_CONNECT_HTTP_PORT` 走）。用它加第二个 bot、改 bot 设置、
看活跃会话。

## 启动

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会启动：

- Bot/API 服务：`127.0.0.1:17666`（用 `AGENT_CONNECT_HTTP_PORT` 改）
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
npm install -g @yc-tech/agent-connect-cli
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
packages/telegramify-markdown/  `@yc-tech/telegramify-markdown` 格式化包
doc/                            项目说明
scripts/                        本地运维脚本
```
