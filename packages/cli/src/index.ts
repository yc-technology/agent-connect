#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
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
  agc stop               Stop EVERY agc process (daemon + foreground server)
  agc stop --force       Skip SIGTERM, send SIGKILL immediately
  agc restart            Restart the server child (supervisor stays up)
  agc status             Show daemon status + last health check
  agc logs               Tail \`current.log\` (Ctrl+C to stop)
  agc supervise          (internal) the supervisor entrypoint — not for direct use

Hooks:
  agc hook               Run the agent hook handler (called by Claude/Codex)
  agc hook --install     Install Claude and Codex hooks

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
 */
async function startDaemon(): Promise<number> {
  const cliScript = fileURLToPath(import.meta.url);
  const node = process.execPath;
  const child = spawn(node, [cliScript, "supervise"], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
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
 * Stop every agc process the CLI knows about:
 *   1. supervisor (if supervisor.json present + pid alive)
 *   2. server child the supervisor is currently running (from supervisor.json)
 *   3. orphaned server from a non-daemon `agc start` (from runtime.json) —
 *      covered separately so foreground users get a working `agc stop` too
 *
 * Strategy:
 *   - SIGTERM all known pids first (lets each run its graceful handler:
 *     supervisor cleans up child + supervisor.json; service.ts cleans up
 *     bots + runtime.json).
 *   - Poll for up to 10s for them to exit.
 *   - Anything still alive → escalate to SIGKILL.
 *   - Always sweep both json files at the end so a half-dead state from
 *     a prior crash gets cleared.
 *
 * `--force`: skip SIGTERM, go straight to SIGKILL. Use when SIGTERM
 * graceful path is itself broken.
 */
async function stopAll(force: boolean): Promise<number> {
  const dir = agentConnectDir(process.env);
  const supervisor = await readSupervisorJson(dir);
  const runtime = await readRuntimeJson(dir);

  type Target = { name: string; pid: number };
  const targets: Target[] = [];
  if (supervisor && isPidAlive(supervisor.supervisorPid)) {
    targets.push({ name: "supervisor", pid: supervisor.supervisorPid });
  }
  if (supervisor?.serverPid && isPidAlive(supervisor.serverPid)) {
    targets.push({ name: "server (under supervisor)", pid: supervisor.serverPid });
  }
  if (
    runtime &&
    isPidAlive(runtime.pid) &&
    !targets.some((t) => t.pid === runtime.pid)
  ) {
    // Foreground `agc start` (no daemon). Its own pid lives in runtime.json.
    targets.push({ name: "server (foreground)", pid: runtime.pid });
  }

  if (targets.length === 0) {
    process.stdout.write(`no agc processes detected as running\n`);
    await sweepStaleJson(dir);
    return 0;
  }

  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
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

  if (force) {
    // SIGKILL is immediate; no graceful handlers will run, so just sweep
    // the json files and report.
    await sleep(200); // give the kernel a tick to actually reap
    await sweepStaleJson(dir);
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

  // Graceful path: poll up to 10s, then escalate to SIGKILL.
  for (let i = 0; i < 50; i += 1) {
    const alive = targets.filter((t) => isPidAlive(t.pid));
    if (alive.length === 0) {
      process.stdout.write(`stopped.\n`);
      await sweepStaleJson(dir);
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
  await sweepStaleJson(dir);
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

async function sweepStaleJson(dir: string): Promise<void> {
  // Always best-effort — files might already be gone.
  await Promise.allSettled([removeSupervisorJson(dir), removeRuntimeJson(dir)]);
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
    const force = argv.slice(1).includes("--force") || argv.slice(1).includes("-f");
    return stopAll(force);
  }
  if (command === "restart") return restartDaemon();
  if (command === "status") return showStatus();
  if (command === "logs") return tailLogs();

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
