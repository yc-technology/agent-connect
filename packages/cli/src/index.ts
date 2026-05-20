#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, watchFile, unwatchFile } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHookClient } from "@yc-tech/agent-connect-bot/hookClient";
import { installAllHooks } from "@yc-tech/agent-connect-bot/hookInstaller";
import { runBotService } from "@yc-tech/agent-connect-bot/service";
import { runSupervisor } from "@yc-tech/agent-connect-bot/supervisor";
import {
  isPidAlive,
  readSupervisorJson,
  removeSupervisorJson
} from "@yc-tech/agent-connect-bot/supervisorJson";
import {
  readRuntimeJson,
  removeRuntimeJson
} from "@yc-tech/agent-connect-bot/runtimeJson";
import { agentConnectDir } from "@yc-tech/agent-connect-bot/utils";
import { request } from "undici";

const HELP_TEXT = `agc command line

Foreground:
  agc start              Start bot service + management API in the foreground
  agc serve              Alias for start

Daemon (supervised, auto-restart):
  agc start --daemon     Start in the background under a supervisor
  agc start -d           Short for --daemon
  agc stop               Stop the daemon (or foreground server if no daemon)
                         Never touches an unrelated process — see --all
  agc stop --all         ALSO kill runtime.json's pid even if it's not the
                         supervisor's server child (e.g. a foreground bot
                         running in parallel during a transition)
  agc stop --force       Skip SIGTERM, send SIGKILL immediately
  agc restart            Restart the server child (supervisor stays up)
  agc status             Show daemon status + last health check
  agc logs               Tail \`current.log\` (Ctrl+C to stop)
  agc supervise          (internal) the supervisor entrypoint — not for direct use

Hooks:
  agc hook               Run the agent hook handler (called by Claude/Codex)
  agc hook --install     Install Claude and Codex hooks

Outbound file delivery:
  agc send <path>        Send a local file to the Telegram topic bound to
                         the current tmux window (50 MB cap; uses the running
                         bot's sendDocument so the file arrives uncompressed)
  agc send <path> --caption "..."
                         Override the default "📎 filename (size)" caption

  agc help               Show this help
`;

async function runHook(argv: string[]): Promise<number> {
  const rest = argv[0] === "hook" ? argv.slice(1) : argv;
  if (rest.includes("--install")) {
    const result = await installAllHooks();
    (result.code === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
    return result.code;
  }
  return runHookClient();
}

/**
 * Detached spawn of `agc supervise`. Parent returns immediately so the
 * user's shell prompt comes back. Supervisor inherits the env (PATH,
 * AGENT_CONNECT_* knobs, TELEGRAM_BOT_TOKEN, …) and writes its pid file.
 *
 * `detached: true` + `unref()` is the canonical Node.js daemon recipe:
 * sets a new process group so SIGTERM to the parent shell doesn't kill
 * the supervisor, and unref-ing the child lets the parent's event loop
 * empty and exit.
 *
 * Two early-bail safety checks before we spawn:
 *   1. If an existing supervisor.json + alive pid says one is already
 *      running, refuse — `supervisor.ts.start()` would error from the
 *      detached child but the CLI parent would have already printed
 *      "started", leaving the user thinking it worked when it didn't.
 *   2. After spawn, `child.pid === undefined` means spawn failed (node
 *      binary missing, permission denied, etc). Report and exit non-zero
 *      instead of printing "started (pid undefined)".
 */
async function startDaemon(): Promise<number> {
  const dir = agentConnectDir(process.env);
  const existing = await readSupervisorJson(dir);
  if (existing && isPidAlive(existing.supervisorPid)) {
    process.stderr.write(
      `agc supervisor already running (pid ${existing.supervisorPid}). ` +
        `Use \`agc restart\` or \`agc stop\` first.\n`
    );
    return 1;
  }
  if (existing && !isPidAlive(existing.supervisorPid)) {
    // Stale supervisor.json from a previous crash — sweep it so the
    // about-to-spawn supervisor's own startup self-check doesn't trip.
    await removeSupervisorJson(dir).catch(() => undefined);
  }

  const cliScript = fileURLToPath(import.meta.url);
  const node = process.execPath;
  const child = spawn(node, [cliScript, "supervise"], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  if (typeof child.pid !== "number") {
    process.stderr.write(`failed to spawn supervisor (no pid assigned by OS)\n`);
    return 1;
  }
  child.unref();
  process.stdout.write(`agc supervisor started (pid ${child.pid})\n`);
  process.stdout.write(`  logs:    agc logs\n`);
  process.stdout.write(`  status:  agc status\n`);
  return 0;
}

async function runSuperviseSubcommand(): Promise<number> {
  // This is the entry the detached child runs after `agc start --daemon`.
  // It boots the supervisor which forks the actual server child.
  const cliScript = fileURLToPath(import.meta.url);
  const dir = agentConnectDir(process.env);
  await runSupervisor({
    nodeExecutable: process.execPath,
    cliScript,
    serverArgs: ["start"],
    httpHost: process.env.AGENT_CONNECT_HTTP_HOST ?? "127.0.0.1",
    httpPort: Number.parseInt(process.env.AGENT_CONNECT_HTTP_PORT ?? "17666", 10),
    configDir: dir
  });
  return 0;
}

/**
 * Stop the agc processes WE manage:
 *
 *   1. If supervisor.json + alive pid → SIGTERM the supervisor (its own
 *      shutdown handler kills the server child + cleans up json files).
 *   2. Otherwise if supervisor.json is stale → sweep it; treat as "no
 *      daemon".
 *   3. Then for runtime.json's pid: ONLY signal it when it's clearly
 *      ours, i.e. either
 *         (a) no live supervisor (the bot must be foreground), OR
 *         (b) --all was passed explicitly.
 *      If a live supervisor exists AND runtime.pid !== supervisor.serverPid,
 *      that runtime.json belongs to SOMEONE ELSE (typically a foreground
 *      bot the user started independently). Leaving it alone is what
 *      saved us from the May-19 "smoke test killed the foreground bot"
 *      incident — the previous version's "kill everything in runtime.json"
 *      took out an unrelated process.
 *
 * Flags:
 *   --force   skip SIGTERM, go straight to SIGKILL.
 *   --all     ALSO signal runtime.json's pid even when a supervisor is
 *             managing a different server (i.e. "actually nuke any agc
 *             process in this config dir").
 *
 * Json sweep is now scoped: only files we successfully killed get
 * removed. supervisor.json gets swept if we killed the supervisor (or it
 * was stale). runtime.json gets swept only if we killed its pid.
 */
async function stopAll(opts: { force: boolean; all: boolean }): Promise<number> {
  const dir = agentConnectDir(process.env);
  const supervisor = await readSupervisorJson(dir);
  const runtime = await readRuntimeJson(dir);

  type Target = { name: string; pid: number; ownsSupervisorJson?: boolean; ownsRuntimeJson?: boolean };
  const targets: Target[] = [];

  let supervisorAlive = false;
  if (supervisor) {
    if (isPidAlive(supervisor.supervisorPid)) {
      supervisorAlive = true;
      targets.push({
        name: "supervisor",
        pid: supervisor.supervisorPid,
        ownsSupervisorJson: true,
        // Supervisor's graceful shutdown kills the server child too, so
        // the supervisor's serverPid (== probably runtime.pid) goes with it.
        ownsRuntimeJson: supervisor.serverPid === runtime?.pid
      });
    } else {
      // Stale supervisor.json from a previous crash — sweep + report.
      await removeSupervisorJson(dir).catch(() => undefined);
      process.stderr.write(
        `cleared stale supervisor.json (pid ${supervisor.supervisorPid} was dead)\n`
      );
    }
  }

  if (runtime && isPidAlive(runtime.pid) && !targets.some((t) => t.pid === runtime.pid)) {
    const ownedByLiveSupervisor =
      supervisorAlive && supervisor!.serverPid === runtime.pid;
    if (ownedByLiveSupervisor) {
      // Already covered transitively by the supervisor target above; no
      // need to add it separately.
    } else if (!supervisorAlive) {
      // No supervisor managing this dir → runtime.json is the foreground
      // server's. Stop it.
      targets.push({
        name: "foreground server",
        pid: runtime.pid,
        ownsRuntimeJson: true
      });
    } else if (opts.all) {
      // Live supervisor but runtime.pid is unrelated. User explicitly
      // asked --all → also stop it.
      targets.push({
        name: "unrelated server (runtime.json mismatch)",
        pid: runtime.pid,
        ownsRuntimeJson: true
      });
    } else {
      // Live supervisor + unrelated runtime.pid + no --all → leave it
      // alone, but TELL the user it's there.
      process.stderr.write(
        `note: runtime.json points to pid ${runtime.pid}, which is NOT supervisor.serverPid ${supervisor!.serverPid}. ` +
          `Looks like a foreground bot started independently — skipping. ` +
          `Pass \`--all\` to stop it too.\n`
      );
    }
  }

  if (targets.length === 0) {
    process.stdout.write(`no managed agc processes detected as running\n`);
    return 0;
  }

  const signal: NodeJS.Signals = opts.force ? "SIGKILL" : "SIGTERM";
  for (const t of targets) {
    try {
      process.kill(t.pid, signal);
      process.stdout.write(`signaled ${t.name} pid ${t.pid} with ${signal}\n`);
    } catch (err) {
      process.stderr.write(
        `failed to signal ${t.name} pid ${t.pid}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  const sweep = async (): Promise<void> => {
    const ops: Promise<unknown>[] = [];
    if (targets.some((t) => t.ownsSupervisorJson)) ops.push(removeSupervisorJson(dir));
    if (targets.some((t) => t.ownsRuntimeJson)) ops.push(removeRuntimeJson(dir));
    await Promise.allSettled(ops);
  };

  if (opts.force) {
    await sleep(200); // give the kernel a tick to actually reap
    await sweep();
    const stillAlive = targets.filter((t) => isPidAlive(t.pid));
    if (stillAlive.length > 0) {
      process.stderr.write(
        `${stillAlive.length} process(es) still alive after SIGKILL — odd; check permissions\n`
      );
      return 1;
    }
    process.stdout.write(`stopped.\n`);
    return 0;
  }

  // Graceful: poll up to 10s for SIGTERM to take effect, then escalate.
  for (let i = 0; i < 50; i += 1) {
    if (targets.every((t) => !isPidAlive(t.pid))) {
      process.stdout.write(`stopped.\n`);
      await sweep();
      return 0;
    }
    await sleep(200);
  }

  const stillAlive = targets.filter((t) => isPidAlive(t.pid));
  for (const t of stillAlive) {
    process.stdout.write(`escalating ${t.name} pid ${t.pid} to SIGKILL\n`);
    try {
      process.kill(t.pid, "SIGKILL");
    } catch {
      // ignore — pid might have died between check and kill
    }
  }
  await sleep(200);
  await sweep();
  const remaining = targets.filter((t) => isPidAlive(t.pid));
  if (remaining.length > 0) {
    process.stderr.write(
      `${remaining.length} process(es) STILL alive after SIGKILL — manual cleanup needed (\`ps\` / \`kill -9\`)\n`
    );
    return 1;
  }
  process.stdout.write(`stopped (some processes required SIGKILL escalation).\n`);
  return 0;
}

async function restartDaemon(): Promise<number> {
  const dir = agentConnectDir(process.env);
  const info = await readSupervisorJson(dir);
  if (!info) {
    process.stderr.write(`no supervisor.json at ${dir} — daemon isn't running\n`);
    return 1;
  }
  if (!isPidAlive(info.supervisorPid)) {
    process.stderr.write(`supervisor pid ${info.supervisorPid} is not alive\n`);
    return 1;
  }
  try {
    process.kill(info.supervisorPid, "SIGUSR2");
  } catch (err) {
    process.stderr.write(
      `failed to signal supervisor pid ${info.supervisorPid}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
  process.stdout.write(
    `sent SIGUSR2 to supervisor pid ${info.supervisorPid}; server child restarting…\n`
  );
  return 0;
}

async function showStatus(): Promise<number> {
  const dir = agentConnectDir(process.env);
  const info = await readSupervisorJson(dir);
  if (!info) {
    process.stdout.write(`agc supervisor: NOT RUNNING (no supervisor.json at ${dir})\n`);
    return 1;
  }
  const alive = isPidAlive(info.supervisorPid);
  process.stdout.write(`agc supervisor:\n`);
  process.stdout.write(`  pid:           ${info.supervisorPid} ${alive ? "(alive)" : "(DEAD — stale supervisor.json)"}\n`);
  process.stdout.write(`  server pid:    ${info.serverPid ?? "(none)"}\n`);
  process.stdout.write(`  listening:     ${info.httpHost}:${info.httpPort}\n`);
  process.stdout.write(`  started at:    ${info.startedAt}\n`);
  process.stdout.write(`  uptime:        ${formatUptime(info.startedAt)}\n`);
  process.stdout.write(`  restart count: ${info.restartCount}\n`);
  if (info.lastRestartReason) {
    process.stdout.write(`  last restart:  ${info.lastRestartAt} (${info.lastRestartReason})\n`);
  }
  if (info.lastHealthCheckAt) {
    process.stdout.write(
      `  last healthz:  ${info.lastHealthCheckAt} ${info.lastHealthCheckOk ? "✓" : "✗"}\n`
    );
  }

  // Live healthz probe so the user gets a fresh snapshot, not whatever
  // the supervisor's tick last wrote.
  process.stdout.write(`  live healthz:  `);
  try {
    const { statusCode } = await request(`http://${info.httpHost}:${info.httpPort}/healthz`, {
      method: "GET",
      headersTimeout: 3_000,
      bodyTimeout: 3_000
    });
    process.stdout.write(`${statusCode} ${statusCode >= 200 && statusCode < 300 ? "✓" : "✗"}\n`);
    return statusCode >= 200 && statusCode < 300 ? 0 : 2;
  } catch (err) {
    process.stdout.write(`unreachable (${err instanceof Error ? err.message : String(err)})\n`);
    return 2;
  }
}

function formatUptime(startedAtIso: string): string {
  const ms = Date.now() - Date.parse(startedAtIso);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function tailLogs(): Promise<number> {
  const dir = agentConnectDir(process.env);
  const path = join(dir, "logs", "current.log");
  if (!existsSync(path)) {
    process.stderr.write(`no log file at ${path}\n`);
    return 1;
  }
  // Stream the existing tail (~last 8 KB) so the user sees recent
  // context, then follow file growth via watchFile polling. fs.watch is
  // unreliable across log-rotation symlink swaps; polling sidesteps that.
  process.stdout.write(`tail -f ${path}\n`);
  await streamLastBytes(path, 8192);

  let prevSize = 0;
  try {
    const { statSync } = await import("node:fs");
    prevSize = statSync(path).size;
  } catch {
    // ignore
  }

  return new Promise<number>((resolve) => {
    const stop = (): void => {
      unwatchFile(path);
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    watchFile(path, { interval: 500 }, async (curr, prev) => {
      if (curr.size === prev.size && curr.mtimeMs === prev.mtimeMs) return;
      if (curr.size < prevSize) {
        // File shrank (rotation/truncation) — start from 0 of the new file.
        prevSize = 0;
      }
      const stream = createReadStream(path, { start: prevSize });
      stream.on("data", (chunk) => process.stdout.write(chunk));
      stream.on("end", () => {
        prevSize = curr.size;
      });
      stream.on("error", () => undefined);
    });
  });
}

async function streamLastBytes(path: string, bytes: number): Promise<void> {
  const { statSync } = await import("node:fs");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    await new Promise<void>((resolve) => {
      const stream = createReadStream(path, { start });
      stream.on("data", (chunk) => process.stdout.write(chunk));
      stream.on("end", () => resolve());
      stream.on("error", () => resolve());
    });
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `agc send <path>` — POST the file path to the running bot's /bot/send-file
 * endpoint. The server reads the file itself (same uid, same FS) and routes
 * it via sendDocument to the Telegram topic bound to the caller's tmux
 * window.
 *
 * Resolves windowId + tmuxSession via `tmux display-message`. Must be run
 * from inside a tmux pane; otherwise the bot has no way to know which topic
 * to target.
 */
async function sendFile(argv: string[]): Promise<number> {
  const rest = argv[0] === "send" ? argv.slice(1) : argv;
  // Hand-rolled parser: collect positionals while consuming `--caption <value>`
  // as a two-arg flag. A naive `rest.find(a => !a.startsWith("--"))` picks up
  // the caption *value* as if it were the path when the user puts the flag
  // first (`agc send --caption "x" /tmp/foo.zip`).
  const positionals: string[] = [];
  let caption: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--caption") {
      const value = rest[i + 1];
      if (value === undefined) {
        process.stderr.write(`--caption requires a value\n`);
        return 1;
      }
      caption = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`unknown flag: ${arg}\n`);
      return 1;
    } else {
      positionals.push(arg);
    }
  }
  const pathArg = positionals[0];
  if (!pathArg) {
    process.stderr.write(`Usage: agc send <path> [--caption "..."]\n`);
    return 1;
  }
  if (positionals.length > 1) {
    process.stderr.write(`agc send takes one path; got ${positionals.length}\n`);
    return 1;
  }
  const absPath = resolvePath(pathArg);
  if (!existsSync(absPath)) {
    process.stderr.write(`file not found: ${absPath}\n`);
    return 1;
  }

  let windowId: string;
  let tmuxSession: string;
  try {
    windowId = execFileSync("tmux", ["display-message", "-p", "#{window_id}"], {
      encoding: "utf8"
    }).trim();
    tmuxSession = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
      encoding: "utf8"
    }).trim();
  } catch (err) {
    process.stderr.write(
      `agc send must run inside a tmux pane (tmux display-message failed: ${err instanceof Error ? err.message : String(err)})\n`
    );
    return 1;
  }
  if (!windowId || !tmuxSession) {
    process.stderr.write(`tmux display-message returned empty window/session\n`);
    return 1;
  }

  const dir = agentConnectDir(process.env);
  const runtime = await readRuntimeJson(dir);
  if (!runtime) {
    process.stderr.write(
      `bot service is not running (no runtime.json at ${dir}). Start it with: agc start\n`
    );
    return 1;
  }

  const body = JSON.stringify({ path: absPath, windowId, tmuxSession, caption });
  try {
    const res = await request(`http://${runtime.httpHost}:${runtime.httpPort}/bot/send-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Uploads + Telegram sendDocument can take a bit for 50 MB files; give
      // the server time before the client times out.
      headersTimeout: 60_000,
      bodyTimeout: 60_000
    });
    const text = await res.body.text();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let parsed: {
        deliveries?: number;
        failed?: number;
        filename?: string;
        sizeBytes?: number;
      } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        // Server returned 200 with non-JSON — fall through with a generic message.
      }
      const name = parsed.filename ?? absPath;
      const size = parsed.sizeBytes !== undefined ? ` (${parsed.sizeBytes} bytes)` : "";
      const fan = parsed.deliveries !== undefined ? ` to ${parsed.deliveries} chat(s)` : "";
      process.stdout.write(`sent ${name}${size}${fan} via ${tmuxSession}:${windowId}\n`);
      // Partial-failure: server delivered to at least one user but some drains
      // rejected. Exit 0 (the send succeeded for someone) but print a warning
      // so the operator notices and checks logs.
      if (parsed.failed && parsed.failed > 0) {
        process.stderr.write(
          `warning: ${parsed.failed} delivery attempt(s) failed (see ~/.agent-connect/logs/current.log)\n`
        );
      }
      return 0;
    }
    process.stderr.write(`send failed (HTTP ${res.statusCode}): ${text}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `send failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (command === "hook") return runHook(argv);
  if (command === "hook:install") return runHook(["hook", "--install"]);

  if (command === "start" || command === "serve" || command === "bot") {
    const rest = argv.slice(1);
    if (rest.includes("--daemon") || rest.includes("-d")) {
      return startDaemon();
    }
    await runBotService(process.env, {
      hookEntrypoint: fileURLToPath(import.meta.url)
    });
    return 0;
  }

  if (command === "supervise") return runSuperviseSubcommand();
  if (command === "stop") {
    const rest = argv.slice(1);
    const force = rest.includes("--force") || rest.includes("-f");
    const all = rest.includes("--all") || rest.includes("-a");
    return stopAll({ force, all });
  }
  if (command === "restart") return restartDaemon();
  if (command === "status") return showStatus();
  if (command === "logs") return tailLogs();
  if (command === "send") return sendFile(argv);

  process.stderr.write(`Unknown command: ${command}\n\n${HELP_TEXT}`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }
);
