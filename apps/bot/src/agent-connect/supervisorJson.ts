import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * State the supervisor process writes for `agc status` / `agc stop` /
 * `agc restart` to read. Written atomically on startup + after every
 * meaningful transition (server respawn, health check tick, shutdown).
 *
 * Lives at `$AGENT_CONNECT_DIR/supervisor.json`, parallel to the existing
 * `runtime.json` (which the server itself maintains). Two separate files
 * because they represent two separate processes:
 *   - runtime.json: server process — written by service.ts at bind time
 *   - supervisor.json: supervisor process — written by supervisor.ts
 *
 * Removed on graceful supervisor shutdown so a stale file doesn't fool
 * `agc status` into thinking the daemon is up. CLI commands cross-check
 * with `process.kill(pid, 0)` before trusting the recorded pid.
 */
export interface SupervisorInfo {
  supervisorPid: number;
  serverPid: number | null;
  httpHost: string;
  httpPort: number;
  /** ISO-8601 timestamp the supervisor itself started (not server child). */
  startedAt: string;
  /** Number of automatic restarts the supervisor has triggered. */
  restartCount: number;
  /** Free-form description of the most recent restart trigger. */
  lastRestartReason: string | null;
  /** ISO-8601 timestamp of the most recent restart, or null. */
  lastRestartAt: string | null;
  /** ISO-8601 timestamp of the most recent health check tick. */
  lastHealthCheckAt: string | null;
  /** Outcome of the most recent health check tick (true=200, false=failed). */
  lastHealthCheckOk: boolean | null;
}

function supervisorPath(dir: string): string {
  return join(dir, "supervisor.json");
}

export async function writeSupervisorJson(dir: string, info: SupervisorInfo): Promise<void> {
  await writeFile(supervisorPath(dir), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export async function readSupervisorJson(dir: string): Promise<SupervisorInfo | null> {
  const path = supervisorPath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SupervisorInfo>;
    if (
      typeof parsed.supervisorPid !== "number" ||
      typeof parsed.httpHost !== "string" ||
      typeof parsed.httpPort !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      supervisorPid: parsed.supervisorPid,
      serverPid: typeof parsed.serverPid === "number" ? parsed.serverPid : null,
      httpHost: parsed.httpHost,
      httpPort: parsed.httpPort,
      startedAt: parsed.startedAt,
      restartCount: typeof parsed.restartCount === "number" ? parsed.restartCount : 0,
      lastRestartReason: typeof parsed.lastRestartReason === "string" ? parsed.lastRestartReason : null,
      lastRestartAt: typeof parsed.lastRestartAt === "string" ? parsed.lastRestartAt : null,
      lastHealthCheckAt: typeof parsed.lastHealthCheckAt === "string" ? parsed.lastHealthCheckAt : null,
      lastHealthCheckOk: typeof parsed.lastHealthCheckOk === "boolean" ? parsed.lastHealthCheckOk : null
    };
  } catch {
    return null;
  }
}

export async function removeSupervisorJson(dir: string): Promise<void> {
  await rm(supervisorPath(dir), { force: true });
}

/**
 * Best-effort "is this PID still alive?" probe. Used by `agc status` and
 * by the supervisor's own startup self-check to detect a stale file from
 * a previous crash. Returns false on permission errors or any throw, on
 * the assumption that "can't observe" ≈ "not running for me".
 */
export function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver a signal — just tests permission/existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
