import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import { request } from "undici";
import { logger } from "./logger.js";
import {
  readSupervisorJson,
  removeSupervisorJson,
  writeSupervisorJson,
  type SupervisorInfo
} from "./supervisorJson.js";

/**
 * Long-running process supervisor. Spawns a child running the bot service,
 * watches it via `GET /healthz` + child-exit events, and respawns it on
 * failure with exponential backoff. Handles three trigger sources through
 * one mutex-guarded restart path so concurrent automatic + manual restart
 * requests can't race:
 *
 *   - child exit (unexpected): `respawnWithBackoff()` → `restartServer()`
 *   - healthz failed N times consecutively: `restartServer()`
 *   - SIGUSR2 from `agc restart`: `restartServer()`
 *
 * State persisted to `supervisor.json` after every transition for
 * `agc status` to read. File removed on graceful shutdown.
 */

export interface SupervisorOptions {
  /** Absolute path to the node executable (typically `process.execPath`). */
  nodeExecutable: string;
  /** Absolute path to the agc CLI entry script. */
  cliScript: string;
  /** Args to pass after the script — typically `["start"]`. */
  serverArgs: string[];
  httpHost: string;
  httpPort: number;
  /** `$AGENT_CONNECT_DIR` — where supervisor.json lives. */
  configDir: string;
  /** Overrideable for tests. */
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  healthCheckFailureThreshold?: number;
  /** Backoff sequence; clamps to last value once exhausted. */
  backoffMs?: number[];
  /** Max time to wait for `/healthz` to come back after a respawn. */
  bootHealthyTimeoutMs?: number;
  /** Crash-loop budget — bail after this many unintentional exits in `restartBudgetWindowMs`. */
  restartBudget?: number;
  restartBudgetWindowMs?: number;
  /** Hook for tests — defaults to actual spawn(node, script, args). */
  spawnFn?: (cmd: string, args: string[]) => ChildProcess;
  /** Hook for tests — defaults to undici request. */
  probeHealthFn?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Hook for tests — defaults to global setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
}

type State = "starting" | "healthy" | "restarting" | "stopping";

const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const DEFAULT_BOOT_HEALTHY_TIMEOUT_MS = 60_000;

// Crash-loop backstop: if the child fails this many times within this
// many milliseconds, give up and let the supervisor exit. Catches
// startup crashes that aren't code=2 (the "explicit bail" path) — e.g.
// a missing dependency or a config error that would otherwise spin
// forever. 8786 respawn cycles were observed in a real user upgrade
// from <0.3.5 with a stale daemon left running; without a backstop the
// loop continued for ~12 hours until the user noticed.
const DEFAULT_RESTART_BUDGET = 5;
const DEFAULT_RESTART_BUDGET_WINDOW_MS = 30_000;

// Server child exit code 2 = "explicit bail, do not respawn". Reserved
// for service.ts to use on runtime-conflict (stale daemon still
// listening on our port).
const EXIT_CODE_EXPLICIT_BAIL = 2;

export interface SupervisorHandle {
  /** Programmatic restart (same path as SIGUSR2). */
  restart(reason: string): Promise<void>;
  /** Programmatic shutdown (same path as SIGTERM). Does not call process.exit. */
  shutdown(reason: string): Promise<void>;
  /** Current internal state — for tests. */
  state(): State;
  /** Number of times this supervisor has triggered a server restart. */
  restartCount(): number;
}

/**
 * Construct the supervisor and run forever. Resolves only on shutdown.
 * Wires SIGTERM / SIGINT (shutdown) and SIGUSR2 (restart) handlers.
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<void> {
  const handle = buildSupervisor(opts);
  process.on("SIGTERM", () => void handle.shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void handle.shutdown("SIGINT").then(() => process.exit(0)));
  process.on("SIGUSR2", () => void handle.restart("manual via SIGUSR2"));
  await handle.start();
  // Resolves only when shutdown completes.
  await handle.stopped;
}

/**
 * Test-friendly factory — exposed so unit tests can drive the state
 * machine without forking real processes or listening for OS signals.
 * `runSupervisor` is the production entry; this returns just the
 * orchestrator.
 */
export function buildSupervisor(opts: SupervisorOptions): SupervisorHandle & {
  start(): Promise<void>;
  stopped: Promise<void>;
} {
  const interval = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const timeout = opts.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const threshold = opts.healthCheckFailureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const bootTimeout = opts.bootHealthyTimeoutMs ?? DEFAULT_BOOT_HEALTHY_TIMEOUT_MS;
  const doSpawn = opts.spawnFn ?? defaultSpawn(opts.nodeExecutable, opts.cliScript);
  const doProbe = opts.probeHealthFn ?? defaultProbeHealth;
  const doSleep = opts.sleepFn ?? defaultSleep;

  // Access through getState/setState so TS's flow-narrowing can't assume
  // the value sticks to a literal between awaits (signal handlers can
  // flip it from another scope; TS can't see that statically).
  let currentState: State = "starting";
  const getState = (): State => currentState;
  const setState = (s: State): void => {
    currentState = s;
  };
  let child: ChildProcess | null = null;
  let restartInFlight: Promise<void> | null = null;
  let unhealthyCount = 0;
  let restartCount = 0;
  let backoffIdx = 0;
  let healthTimer: NodeJS.Timeout | null = null;
  // Crash-loop guard: sliding-window of recent child-exit timestamps.
  // If we hit `restartBudget` exits within `restartBudgetWindowMs`, stop
  // respawning. Catches startup-crashing children that aren't using the
  // code-2 bail path (e.g. older versions, or genuine bugs).
  const restartBudget = opts.restartBudget ?? DEFAULT_RESTART_BUDGET;
  const restartBudgetWindowMs = opts.restartBudgetWindowMs ?? DEFAULT_RESTART_BUDGET_WINDOW_MS;
  const recentExits: number[] = [];
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));

  const info: SupervisorInfo = {
    supervisorPid: process.pid,
    serverPid: null,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    lastRestartReason: null,
    lastRestartAt: null,
    lastHealthCheckAt: null,
    lastHealthCheckOk: null
  };

  async function persist(): Promise<void> {
    info.serverPid = child?.pid ?? null;
    info.restartCount = restartCount;
    try {
      await writeSupervisorJson(opts.configDir, info);
    } catch (err) {
      logger().warn({ err }, "supervisor: failed to write supervisor.json");
    }
  }

  function spawnServer(): ChildProcess {
    logger().info(
      { cmd: opts.nodeExecutable, script: opts.cliScript, args: opts.serverArgs },
      "supervisor: spawning server child"
    );
    const c = doSpawn(opts.nodeExecutable, opts.serverArgs);
    c.on("exit", (code, signal) => {
      const wasIntentional = getState() === "stopping" || getState() === "restarting";
      logger().warn(
        { pid: c.pid, code, signal, wasIntentional },
        "supervisor: server child exited"
      );
      if (wasIntentional) return;

      // Code 2 = "explicit bail, do not respawn". service.ts uses this
      // when it detects another agent-connect already listening on our
      // port (typical scenario: user upgraded the npm package without
      // running `agc stop` first, so a stale daemon is still bound).
      // Respawning would just hit the same conflict forever.
      if (code === EXIT_CODE_EXPLICIT_BAIL) {
        logger().error(
          { code, signal },
          "supervisor: server child bailed with code 2 — not respawning. " +
            "Run `agc stop --all` then `agc start --daemon` for a clean restart."
        );
        setState("stopping");
        resolveStopped();
        return;
      }

      // Backstop: if recent exits exceed the budget, stop respawning.
      // Stale daemons predating the code-2 fix (or genuine startup
      // bugs) would otherwise loop forever — 8786 cycles seen in the wild.
      const now = Date.now();
      recentExits.push(now);
      while (recentExits.length > 0 && now - recentExits[0]! > restartBudgetWindowMs) {
        recentExits.shift();
      }
      if (recentExits.length > restartBudget) {
        logger().error(
          {
            recentExits: recentExits.length,
            budget: restartBudget,
            windowMs: restartBudgetWindowMs,
            lastCode: code,
            lastSignal: signal
          },
          "supervisor: crash-loop backstop tripped — refusing further respawns. " +
            "Investigate logs; `agc stop --all` then `agc start --daemon` once root cause is fixed."
        );
        setState("stopping");
        resolveStopped();
        return;
      }

      void respawnWithBackoff(
        `server child exited unexpectedly (code=${code ?? "?"} signal=${signal ?? "?"})`
      );
    });
    return c;
  }

  async function respawnWithBackoff(reason: string): Promise<void> {
    const delay = backoff[Math.min(backoffIdx, backoff.length - 1)]!;
    backoffIdx += 1;
    logger().warn({ delay, attempt: backoffIdx, reason }, "supervisor: backing off before respawn");
    await doSleep(delay);
    if (getState() === "stopping") return;
    await restartServer(reason);
  }

  async function restartServer(reason: string): Promise<void> {
    if (getState() === "stopping") return;
    if (restartInFlight) {
      logger().info({ reason }, "supervisor: restart coalesced with in-flight restart");
      return restartInFlight;
    }
    restartInFlight = doRestart(reason).finally(() => {
      restartInFlight = null;
    });
    return restartInFlight;
  }

  async function doRestart(reason: string): Promise<void> {
    setState("restarting");
    unhealthyCount = 0;
    restartCount += 1;
    info.lastRestartReason = reason;
    info.lastRestartAt = new Date().toISOString();
    await persist();
    logger().info({ reason, restartCount }, "supervisor: restarting server child");

    if (child) {
      await killChildGracefully(child, 10_000);
      child = null;
    }
    // shutdown may have flipped state during the kill await — bail before
    // spawning a new child that nobody will manage.
    if (getState() === "stopping") return;

    setState("starting");
    child = spawnServer();
    await persist();
    const ok = await waitForHealthy(opts.httpHost, opts.httpPort, timeout, bootTimeout, doProbe, doSleep);
    if (getState() === "stopping") return;
    if (ok) {
      setState("healthy");
      backoffIdx = 0;
      logger().info({ serverPid: child?.pid }, "supervisor: server healthy after restart");
    } else {
      logger().error("supervisor: server failed to become healthy within boot timeout");
      // Leave state at "starting" so health-tick won't trigger another
      // restart immediately; the backoff loop above kicks in via the
      // child's eventual exit. If it didn't exit at all, the next health
      // tick will keep counting failures and eventually restart.
    }
  }

  async function healthTick(): Promise<void> {
    // Don't probe during restart/shutdown — would race with kill+spawn.
    if (getState() !== "healthy" && getState() !== "starting") return;
    const ok = await doProbe(opts.httpHost, opts.httpPort, timeout);
    info.lastHealthCheckAt = new Date().toISOString();
    info.lastHealthCheckOk = ok;
    await persist();
    if (ok) {
      unhealthyCount = 0;
      if (getState() === "starting") setState("healthy");
      return;
    }
    unhealthyCount += 1;
    logger().warn({ unhealthyCount, threshold }, "supervisor: healthz failed");
    if (unhealthyCount >= threshold) {
      void restartServer(`healthz failed ${threshold} times consecutively`);
    }
  }

  async function start(): Promise<void> {
    // Detect a stale supervisor.json from a previous crash — refuse to
    // start a second supervisor on top of a live one.
    const existing = await readSupervisorJson(opts.configDir);
    if (existing && existing.supervisorPid !== process.pid && pidAlive(existing.supervisorPid)) {
      throw new Error(
        `another supervisor is already running (pid ${existing.supervisorPid})`
      );
    }
    await persist();
    child = spawnServer();
    await persist();
    const ok = await waitForHealthy(opts.httpHost, opts.httpPort, timeout, bootTimeout, doProbe, doSleep);
    if (getState() === "stopping") return;
    setState(ok ? "healthy" : "starting");
    if (!ok) {
      logger().error("supervisor: initial boot didn't become healthy in time; will keep probing");
    }
    healthTimer = setInterval(() => void healthTick(), interval);
    // Unref so the timer doesn't block process exit on its own.
    healthTimer.unref();
  }

  async function shutdown(reason: string): Promise<void> {
    if (getState() === "stopping") return;
    setState("stopping");
    logger().info({ reason }, "supervisor: shutting down");
    if (healthTimer) clearInterval(healthTimer);
    if (child) await killChildGracefully(child, 10_000);
    try {
      await removeSupervisorJson(opts.configDir);
    } catch {
      // best-effort
    }
    logger().info({ reason }, "supervisor: stopped");
    resolveStopped();
  }

  return {
    start,
    stopped,
    restart: restartServer,
    shutdown,
    state: getState,
    restartCount: () => restartCount
  };
}

function defaultSpawn(node: string, script: string) {
  return (_cmd: string, args: string[]): ChildProcess =>
    spawn(node, [script, ...args], { stdio: "ignore", env: process.env });
}

async function defaultProbeHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  try {
    const { statusCode } = await request(`http://${host}:${port}/healthz`, {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });
    return statusCode >= 200 && statusCode < 300;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealthy(
  host: string,
  port: number,
  perTryTimeoutMs: number,
  totalMs: number,
  probe: (h: string, p: number, t: number) => Promise<boolean>,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await probe(host, port, perTryTimeoutMs)) return true;
    await sleep(500);
  }
  return false;
}

function killChildGracefully(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    // tree-kill walks the process group so any worker threads / forked
    // children (Fastify's pino transport worker, for instance) go down
    // with the parent.
    treeKill(child.pid, "SIGTERM", (err) => {
      if (err) {
        logger().warn({ err: err.message, pid: child.pid }, "supervisor: tree-kill SIGTERM failed");
      }
    });
    const timer = setTimeout(() => {
      if (done || !child.pid) return;
      logger().warn(
        { pid: child.pid, timeoutMs },
        "supervisor: graceful shutdown timed out — escalating to SIGKILL"
      );
      treeKill(child.pid, "SIGKILL", () => finish());
    }, timeoutMs);
    timer.unref();
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
