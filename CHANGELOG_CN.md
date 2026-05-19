# 更新日志

本文件记录项目所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

English: [CHANGELOG.md](./CHANGELOG.md).

---

## 0.2.0 — 2026-05-19

### ⚠️ 破坏性变更

- **默认 HTTP 端口从 `8787` 改为 `17666`**，避开 RStudio Server 的默认端口冲突
  （RStudio Server 也默认 8787）。需要保留旧端口设
  `AGENT_CONNECT_HTTP_PORT=8787` 即可。Hook 通过 `runtime.json` 动态发现端口，
  **不需要重装 hook**。
- Web 控制台地址相应变为 `http://127.0.0.1:17666/`（或你设置的端口）。

### ✨ 新增 — Daemon 后台模式

- `agc start --daemon`（别名 `-d`）—— 启动一个 detached supervisor 进程，
  它 fork bot service 作为子进程，跟你的 shell 解耦。
- `agc stop` —— 优雅停止 supervisor + server。也能处理无 daemon 的前台 bot
  场景。`--force`（SIGKILL）+ `--all`（连同同一 config 目录下不相关的 server
  一起杀）作为升级选项。
- `agc restart` —— SIGUSR2 给 supervisor，重新 spawn server 子进程。新代码
  （`npm i -g @yc-tech/agent-connect-cli@latest` 或 `git pull && pnpm build`
  之后）会自动生效，**不需要 stop + start 两步**。
- `agc status` —— 显示 uptime、重启次数、最近健康检查 + 现场 healthz 探活。
  退出码 0/1/2 便于脚本使用。
- `agc logs` —— 跟随 `~/.agent-connect/logs/current.log`（用 watchFile 轮询
  跟随 symlink，**轮转后自动跟新文件**）。
- Supervisor 状态机带 single-flight restart 锁：手动 SIGUSR2、healthz 失败
  自动重启、child 异常退出 respawn 三个触发源走同一条路径，并发不冲突。
- 健康监控：每 10s `GET /healthz`，连续 3 次失败触发重启；child 异常退出
  按指数退避 respawn（1s / 2s / 5s / 10s / 30s 封顶）。
- `supervisor.json` 跟 `runtime.json` 并存持久化 daemon 状态；CLI 通过
  `process.kill(pid, 0)` 实时探活，防 stale 文件误导。

### ✨ 新增 — Web 控制台由 bot serve

- React 管理控制台现在由 Fastify 在 `/` 直接 serve。
- `npm i -g @yc-tech/agent-connect-cli` 装的用户**开箱即用**，不用单独
  跑 vite，不用额外安装。
- `pnpm dev` 工作流不变 —— 本地开发时 vite 仍在 `:5173` 跑（带热重载）。

### ✨ 新增 — Claude 工具图片现在能到 TG

- 带图的 `tool_result`（比如 Claude 的截图工具）不再被默认的
  `showToolCalls=false` 抑制，会作为带 caption 的照片到 Telegram，
  caption 为 `📷 <ToolName>`。
- `sendPhoto` 在 TG 拒收时（`PHOTO_INVALID_DIMENSIONS`、超过 10MB 等）
  自动 fallback 到 `sendDocument`，保留原图质量，上限 50MB。
- 已知 TG 不接受的格式（SVG / TIFF / PDF / …）通过 allowlist 直接走
  document，省一次失败 API 调用。
- 文件名根据 `mediaType` 派生（`.png` / `.jpg` / `.webp` / …），用户
  下载时扩展名正确。

### ✨ 新增 — 速率限制加固

- Status edit 加节流，默认 `AGENT_CONNECT_STATUS_THROTTLE_MS=3000`，
  防止 `Compacting conversation… (Xs) NN%` 这种每秒变的 status 撞到 TG
  edit 速率限制。
- Content path 的 429 重试：`sendWithFallback` 和 tool_result
  `editWithFallback` 现在会读 `retry_after` 等待重试，最多 4 次。之前
  retry-after 信号被静默丢弃 → 消息丢失。
- `isRetryAfter` 识别 grammY 的 `error.parameters.retry_after` 形状
  （之前只认旧的直接字段）。

### ✨ 新增 — 结构化日志

- pino + pino-roll 按天轮转，路径
  `~/.agent-connect/logs/agent-connect.<YYYY-MM-DD>.<N>.log`。
- `current.log` 符号链接始终指向当前活动文件，`tail -f current.log`
  **轮转后还能用**。
- 30 文件保留上限（配合 50MB/文件的硬限，最坏 ~1.5GB）。
- 业务代码里所有 `console.*` 全部迁到带结构化字段（windowId、sessionId、
  event、userId 等）的统一 logger。
- 环境变量：`AGENT_CONNECT_LOG_LEVEL`（默认 `info`），
  `AGENT_CONNECT_LOG_STDOUT=1` 同时镜像到 stdout。

### ✨ 新增 — TUI 识别

- Claude `/resume` session picker 现在能在 TG 弹出带 inline keyboard。
- "Resume from summary?" 长 session 警告（Claude 在你选了一个老的、大的
  session 后会问的那个）也能识别。

### 🐛 修复 — drain-from-0 系列 bug

这是 "TG 突然刷一堆几小时前的老消息" 的根因。

- `SessionStart source=resume`：offset 不再从 0 起，而是从当前 transcript
  EOF 起。所以 `claude --resume <id>` 不再把整段历史 re-emit 到 TG。
- `SessionStart source=compact`：同样的修复 —— Claude 在 compact 时**不会**
  截断 jsonl（它追加一个 summary），所以从 0 起 drain 会重发所有已经
  发过的内容。
- `lazyRegisterIfMissing`：bot 在 Claude/Codex 已经运行时启动、或 topic
  绑到已有的 tmux window —— 也按 EOF 起，不重放历史。
- 抽取出 `offsetSkippingHistory` helper，每个 source 的取舍写在一处。

### 🐛 修复 — Compact UX

- compact 完成时主动发 "✨ Compact done — ready to continue" 通知（compact
  在 TUI 里静默结束，TG 用户之前完全没信号）。
- compact 进行中实时显示进度：
  `Compacting conversation… (17s) 18%`（百分比从 TUI 的进度条解析）。

### 🐛 修复 — Status 正则

- 带音节符号的过去式动词（`Sautéed for 17s`、`Flambéed for 5s`）—— 之前
  `[A-Za-z]` 漏掉这些 → 它们作为"仍在运行"的状态推到 TG，直到下一条消息
  覆盖才消失。
- `· 备注` 后缀（`Brewed for 34s · 1 shell still running`）—— 不再阻止
  "已完成"的判定。
- 多单位时间（`Worked for 1m 5s`、`Cooked for 2h 13m`、
  `Sautéed for 2h 13m 45s`）。

### 🐛 修复 — Daemon CLI 安全

- `agc stop` 不再误杀 `runtime.json` 里来路不明的进程（5月19日"smoke test
  把前台 bot 杀了"事故）。当 supervisor 活着且 runtime.json 的 pid 不等于
  supervisor.serverPid 时，那个进程被识别为"另一个并行跑的前台 bot"，
  默认**不动**它（除非 `--all`）。
- `agc start --daemon` 检测到已有活的 supervisor 会拒绝启动；上一次 crash
  留下的 stale `supervisor.json` 会自动清扫。
- spawn 失败时报清晰错误，不再打印
  `agc supervisor started (pid undefined)`。

---

## 0.1.1 — 2026-05-19

`0.1.0...0.1.1` 之间是 0.2.0 前的一批 bug 修复和结构化日志铺底，详见
git log。

## 0.1.0 — 2026-05-19

在 npm 上以 `@yc-tech` scope 首次发布。
