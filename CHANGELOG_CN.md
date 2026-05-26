# 更新日志

本文件记录项目所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

English: [CHANGELOG.md](./CHANGELOG.md).

---

## 0.3.4 — 2026-05-26

### 🚨 关键 — 0.3.1 / 0.3.2 / 0.3.3 在 npm 上**装不上**

这三个版本发布的 tarball `dependencies` 里漏了 `workspace:*` 字面量：

```
@yc-tech/agent-connect-cli  →  "@yc-tech/agent-connect-bot": "workspace:*"
@yc-tech/agent-connect-bot  →  "@yc-tech/telegramify-markdown": "workspace:*"
```

npm registry 不认 pnpm 的 `workspace:` 协议，所以
`npm i -g @yc-tech/agent-connect-cli@0.3.x` (1 ≤ x ≤ 3) 会直接报
`EUNSUPPORTEDPROTOCOL` 失败。根因是发布流程从 `pnpm publish`（会把
`workspace:*` 改写成 lockfile 里的版本号）切到了 `npm publish`，
而 npm 不做这个改写。0.3.0 没事，因为它在这个流程切换前。

本次 release 功能上和 0.3.3 一样。修复完全在发布流程上：

- 改用 `pnpm publish` 从各 package 目录发，`workspace:*` 被改写成
  精确版本号（`"@yc-tech/agent-connect-bot": "0.3.4"`、
  `"@yc-tech/telegramify-markdown": "0.1.1"`）。
- 0.3.1 / 0.3.2 / 0.3.3 在 npm 上标记为 deprecated，指向 0.3.4。

**升级**：`npm i -g @yc-tech/agent-connect-cli@latest`（或 `@^0.3.4`）。
之前停在 0.3.0 的话，直接跳到 0.3.4 没问题。

### 📋 0.3.1 → 0.3.3 内容回顾（现在才真正可用）

如果你是从 0.3.0 直接跳过来，本次 release 把那三个版本想送的内容
一次性带齐：

- **0.3.1**：Plan-A tmux outage 容错（tmux 死也不丢 DB）；
  `thread_bindings` 软删除 + FK SET NULL + 新增 `last_session_id`
  恢复锚点；`/join` resume picker 默认高亮上次绑过的 session。
- **0.3.2**：订阅 Claude 的 `StopFailure` hook（rate_limit /
  server_error / billing_error 等显式报到 TG + 清掉卡住的 spinner）；
  `/resume` 斜杠命令 + `forwardCommandHandler` 对 recovery_pending
  的友好提示。
- **0.3.3**：`parseStatusLine` 在 TUI input 被双 chrome 夹住的新布局
  下正确锚定上方 chrome（修了"Manifesting…"卡住）；`agc send` 用
  `$TMUX_PANE` 算 windowId，不被 tmux 当前 active window 误导。

每个版本的细节在下面各自的 section。schema migration 还是首次启动
时自动跑。

---

## 0.3.3 — 2026-05-25

### 🐛 修复 — `parseStatusLine` 在 input 被双 chrome 夹住时锚错

Claude TUI 现在把 input 行**上下都包了 chrome 分隔线**：

```
✻ Worked for 36s              ← spinner（在上面）
● How is Claude doing...      ← rating 提示（被跳过）
─────────────────────────     ← chrome 1（input 上方）
❯ commit 这些改动              ← 用户输入回显
─────────────────────────     ← chrome 2（input 下方）
  ⏵⏵ bypass permissions ...   ← footer
```

`searchStart = lines.length - 10` 只能看见 chrome 2。从 chrome 2 向上走第一步
就碰到 `❯` 输入箭头，终止，返回 null。Telegram 停在上一条 spinner 文本上不动
（实测："Manifesting… (35s · ↑ 321 tokens · thinking more)" 在 Claude 实际
已完成后还挂了好几分钟）。改成搜索范围扩到末尾 15 行 + 锚到**最上面**的 chrome
（pane 顺序里靠前那条）；walk-back 自然能找到 spinner。+1 测试锁定
chrome/input/chrome/footer 四段式布局。

### 🐛 修复 — `agc send` 算 windowId 时拿到了错的 window

`agc send /path/to/file` 跑的是 `tmux display-message -p "#{window_id}"`，
**不带 `-t`** —— tmux 这种情况返回的是 client 当前 focus 的 window，**不是
exec 这个 CLI 的 pane 所在的 window**。所以 Claude 在 `@4` 里调 `agc send`
可能拿到 `@0`，然后报 "no Telegram topic is bound to window @0" 哪怕 @4
其实是绑定好的。现在改用 `$TMUX_PANE` 环境变量（tmux 给每个 child 进程都
设置的）显式作 `-t`，lookup 永远反映调用方的 pane。`agc hook` 早就写对了。

---

## 0.3.2 — 2026-05-22

### 🐛 修复 — turn 级 API 错误不再让 Telegram 卡在 stale 状态

turn 因上游 API 错误（rate_limit / server_error / billing_error / …）
结束时，Claude Code 会发 `StopFailure` hook —— 但我们之前没订阅，所以
失败是**静默**的，Telegram 一直停在最后那条 spinner 状态文字上。复现：
`/compact` 收到 Claude API 500，pane 上的 spinner 直接消失没有完成
标记，`parseStatusLine` 返回 null，Telegram 卡在
"Compacting conversation… 1%" 不动。

- `hookInstaller` 让 Claude 订阅 `StopFailure`（Codex 不发此事件，
  install 列表不变）。
- `hookRouter` 处理 `StopFailure` → `onDrain`（吃掉错误前的残留输出）
  → `fireStopFailure` → `fireTurnEnd("failure")`。
- `fireStopFailure` 格式化 `❌ Turn failed (server_error) — <message>`
  通过现有的 `onStatusEvent` 通道发出去 —— 那条 stale spinner status
  会被**编辑覆盖**为错误文字。
- `fireTurnEnd("failure")` 的实现早就在 `multiBotRuntime` 里写好
  （给最后那条 assistant 消息加 🤔 而不是 👌），这次是**第一个真实**
  调用 failure 路径的事件。

`agc hook --install` 在 bot 启动时自动把 `StopFailure` 写进
`~/.claude/settings.json`，老用户下次 service 重启就生效。

### ✨ 新增 — `/resume` 斜杠命令 + recovery-aware 兜底

- `/resume` 加入 `/clear` / `/compact` / `/cost` / `/help` / `/memory` /
  `/model` 这组转发命令。TG 输 `/resume` → bot 把 `/resume` 转给绑定
  的 tmux window → Claude 弹原生 TUI session picker；后续抓取走的就是
  `terminalParser` 现有的 `ResumeSession` pattern + `interactiveUi`
  的 inline keyboard（↑↓⏎⎋ 全在）。**0 新投递代码**，纯菜单 + 路由。
- `forwardCommandHandler` 之前在 `resolveWindowForThread` 返回 null
  时一律回 `❌ No session bound to this topic.`。0.3.1 软删除之后
  binding 行可能仍存在（`window_id = NULL` + `last_session_id` 锚点）
  —— 绑定**还在**，只是脱离了 window。现在 handler 会查
  `getRecoveryAnchor`：有锚点就给一个引导用户重连的专用提示，没有
  锚点的兜底文案不动。

---

## 0.3.1 — 2026-05-22

### 🐛 修复 — tmux 挂掉不再清空 bot DB

跑了约 13 小时之后 tmux server 死了（tmux 3.6a 在 macOS 26.2 Apple
Silicon 上的已知 bug，见 [tmux/tmux#4777](https://github.com/tmux/tmux/issues/4777)）。
bot 下一 tick 看到所有 binding 的 window 全不见了，`cleanupTopicBinding`
对每条都跑一遍，FK CASCADE 在一个 tick 内把 `sessions` /
`thread_bindings` / `user_window_offsets` 全清掉。**5 个 topic 的 session
锚点一次性丢失。**

- `tmuxManager.listWindowsAuthoritative()` 返回判别联合
  `{ok:true,windows} | {ok:false,reason}`。server 不可达、session 不存在、
  exec 失败现在各有清晰 reason，不再塌缩成"空列表"。
- `statusPolling.tick` 每个 tick 只调一次。`{ok:false}` → log + return，
  **完全不进入** binding 循环。bindings 在 tmux 死期间得以保留。
- `{ok:true}` 时把 resolved window 直接传给 `updateStatusMessage`，去掉
  下游的重复 lookup（每 binding 每 tick 的 tmux exec 数从 3 → 1+N，**同
  样负载下 fork 数减少约 5 倍**）。
- Poll 间隔默认从 1s → 2s。可用 `AGENT_CONNECT_STATUS_POLL_INTERVAL_MS`
  覆盖。

### ✨ 新增 — 软删除 binding + resume picker 默认高亮上次 session

当 window 确实从 tmux 消失时（server 回来但具体 window 没了），binding
现在会**保留下来**，用户重新 /join 一下就能恢复到同一个 session。

- schema 迁移：`thread_bindings.window_id` 可空；FK 改为
  `ON DELETE SET NULL`（原本是 CASCADE）；新增 `recovery_pending` 列。
  SQLite 不支持 `ALTER COLUMN`，所以走的是经典的表重建 dance，包在
  单一事务里。幂等 —— 用 PRAGMA shape check 同时校验 column +
  nullable + FK action 三处。
- 新列 `last_session_id`：每次 `SessionStart` hook（含
  `lazyRegisterIfMissing`）都把 session_id 写到 binding 行。`/clear` /
  `/compact` / 手动 `--resume` / 自动恢复都统一覆盖。
- `markBindingForRecovery(userId, threadId)` 清空 `window_id` + 把
  `recovery_pending=1` 置上，然后删 windows 行触发 FK SET NULL。binding
  行保留，last_session_id 保留。
- `buildSessionPicker` 支持 `recommendedSessionId` 参数。匹配的那条
  在 markdown 文本里加 ★ 前缀 + "(previous)" 标签，按钮也加 ★。`/join`
  流程从 `sessionManager.getRecoveryAnchor(userId, threadId)` 拿锚点
  传进去，tmux 重启后用户一眼就能看到默认选项。
- 在 `down → up` 状态转换时，statusPolling 给每个 recoverable thread
  发一条 Telegram 通知："tmux server was restarted. The previous
  session for this topic (session xxxx) is preserved — send any message
  in this topic to /join and resume it."

### 🐛 修复 — picker 静默送不出去

`interactiveUi.ts` 之前有个 `catch { return false }` 把所有 Telegram
错误都吃掉。另一个独立根因：tmux 的 `capture-pane` 默认只抓可见
viewport（无 scrollback）。AskUserQuestion 选项描述长的时候，picker 的
`☐` 顶部标记被顶出可见区，解析器静默匹配失败。

- `capturePane` 现在带 `-S -200`，拿 200 行 scrollback。高 picker 能
  正确解析。
- `terminalParser.tryExtract` 改为**从底向上扫**：带了 scrollback 之后
  会同时看到旧 picker 残留和当前 picker，自上而下扫会锁到旧的。自下
  而上保证总锁到最新的。多行 `top` pattern（如 ResumeSummaryPrompt）
  仍正确处理 —— 对每条 regex 单独求最近匹配，再取最早的。
- `interactiveUi` 在每个静默失败路径都打日志，按
  (windowId, error class) 60s 节流避免刷屏。

### 🧹 内部

- `errorMessage(unknown): string` helper 抽到 `utils.ts`（和
  `statusPolling.ts` 去重）；处理 grammy 在 Telegram API 错误上的
  `.description` 字段。
- 27 个新测试散落在 `sessionRegistry` / `session` / `statusPolling` /
  `directoryBrowser` / `terminalParser`；锁定 codex 提的边角 case（NULL
  hydration、recovery_pending 过滤、迁移 shape 校验、多 picker
  scrollback）。

---

## 0.3.0 — 2026-05-21

### ✨ 新增 — `agc send <path>` 外发文件能力

- 新 CLI 子命令：`agc send /tmp/build.zip [--caption "..."]` 把本地文件
  （上限 50 MB）以**不压缩**的方式作为 Telegram document 发到当前 tmux
  window 绑定的 topic。走 bot 的 message queue，跟 transcript drain
  公平竞争；默认 caption 是 `📎 <filename> (<size>)`。
- 新 HTTP endpoint `POST /bot/send-file`（body: `{ path, windowId,
  tmuxSession, caption? }`）。校验失败返回 400/404/413；全部投递失败
  返回 502；部分成功返回 200 + `{ deliveries, failed }`。
- Server 现在**等待** message-queue drain 完成后再响应 —— CLI 不再
  在 TG 挂掉/被 429 限流时撒谎说"已发送"。

### ✨ 新增 — 内置 skill 自动安装到 ~/.claude & ~/.codex

- `apps/bot/skills/<name>/**` 整个目录树随 npm 包发布（位于
  `dist/skills/`），bot service 每次启动**递归**同步到
  `~/.claude/skills/<name>/` 和 `~/.codex/skills/<name>/`。逐文件字节
  比对，无变化时静默；安装失败不会阻塞 bot 启动。
- 新 skill `agc-send-file`：告诉 Claude / Codex 用户要文件时直接调
  `agc send <path>`，别去 base64 编码二进制。

### 📖 文档

- README 新增 **Quick Start (npm install)** / **快速开始（npm 安装）**
  章节，从 `npm i -g @yc-tech/agent-connect-cli` 一路带到第一条端到端
  消息，附常见坑表。可以直接发给 Claude / Codex —— agent 读 README
  就能带用户走完整个 setup（一开始考虑做 skill，但 skill 要 daemon 起
  来一次之后才会装到 ~/.claude/skills，新装用户那一刻找不到 skill，
  所以放 README 才对）。README_CN.md 同步。

### 🐛 修复 — parseStatusLine 跳过 Claude 遥测提示行

- walk-back 现在跳过以 `⏺`（U+23FA，RECORD-CIRCLE）开头的行 ——
  Claude 的 "Can Anthropic look at your session transcript?" 提示用
  的就是这个字符，之前会让 walk-back 早早终止，导致整个计算过程
  TG 上只看到 `Thinking…`，看不到实时的 `Hashing… (3m 21s ↓ 9.1k
  tokens)` 之类的动态。之前 `●`（U+25CF）的 skip 规则只覆盖"How
  is Claude doing this session?" 评分提示，没盖到这个 codepoint。

### 🔧 内部

- `ToolResultImage` 加了可选 `filename` 字段，调用方可以覆盖
  `image.bin` 那种合成名（`agc send` 用这个保留真实 basename）。
- 测试：+12 个 case（8 dispatcher + 1 queue-filename + 3 parser/skills）。
  357 个全部通过。

---

## 0.2.1 — 2026-05-19

### 🐛 修复

- TG 图片清晰度问题：`sendPhoto` 强制压缩到 ~1280px JPEG，截图 / 密集 UI
  细节看不清。新默认把带图的 `tool_result` 走 `sendDocument`（不压缩、
  保留原画质、上限 50MB）。现代 TG 客户端依然会显示图片文档的缩略图预览，
  UX 差别很小，清晰度提升明显。

### 🎛 新环境变量

- `AGENT_CONNECT_IMAGE_AS_DOCUMENT`（默认 `true`）。设为 `false` 回到
  老的"压缩但有 inline 预览"行为。

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
