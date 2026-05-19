import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { agentConnectDir } from "./utils.js";

/**
 * Shared structured logger for the bot service.
 *
 * Destination: `$AGENT_CONNECT_DIR/logs/` — pino-roll names each rotated
 * file `agent-connect.<YYYY-MM-DD>.<N>.log` (`N` is the rotation counter
 * within that day; starts at 1 each midnight, increments on size cap):
 *
 *     ~/.agent-connect/logs/
 *       current.log                          → symlink → active file
 *       agent-connect.2026-05-19.1.log       (today)
 *       agent-connect.2026-05-18.1.log       (yesterday)
 *       agent-connect.2026-05-17.2.log       (older — was rotated mid-day)
 *
 * Rotation triggers:
 *   - frequency: `daily` → fresh file at local-midnight
 *   - size: `50m`        → fresh file mid-day if the active one fills up
 *                          (guardrail against a runaway loop pre-midnight)
 *
 * Retention: `limit.count: 30` keeps the 30 most recent rotated files in
 * addition to the active one (~30 days under normal cadence; more days if
 * size triggers are rare, fewer if size triggers run hot).
 *
 * Tail-the-current-file: `tail -f ~/.agent-connect/logs/current.log` —
 * the `symlink: true` option keeps `current.log` pointing at whatever
 * `agent-connect.<date>.<N>.log` is currently being written, so the same
 * tail command keeps working across a rotation.
 *
 * Env knobs:
 *   - `AGENT_CONNECT_LOG_LEVEL`  default `info`. One of pino's
 *      `trace|debug|info|warn|error|fatal|silent`.
 *   - `AGENT_CONNECT_LOG_STDOUT=1` also mirror to stdout (useful during
 *      `pnpm dev:bot` so you can tail in the terminal AND have a file).
 *
 * Related env (lives in messageQueue, not here, but worth listing
 * alongside since they're operationally adjacent):
 *   - `AGENT_CONNECT_STATUS_THROTTLE_MS`  default `3000`. Min spacing
 *      between consecutive Telegram status edits per (user, thread).
 *      Lower = snappier status text, higher = safer vs TG rate limit.
 *
 * Test mode (`NODE_ENV=test` or `VITEST=true`) returns a silent pino so
 * vitest output stays clean. Tests that need to assert on log output
 * should call `setLoggerForTesting(captureLogger)` — see
 * `tests/helpers/testLogger.ts`.
 *
 * Singleton built lazily on first `logger()` call so imports stay cheap
 * and CLI tools that never log don't create empty log dirs.
 */
let cached: Logger | null = null;

export function logger(): Logger {
  if (!cached) cached = buildLogger();
  return cached;
}

/** Replace the singleton — tests only. Pass `null` to reset. */
export function setLoggerForTesting(l: Logger | null): void {
  cached = l;
}

function buildLogger(): Logger {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  if (isTest) {
    return pino({ level: "silent" });
  }

  const dir = join(agentConnectDir(), "logs");
  mkdirSync(dir, { recursive: true });

  const level = process.env.AGENT_CONNECT_LOG_LEVEL ?? "info";

  const targets: Array<{
    target: string;
    level: string;
    options: Record<string, unknown>;
  }> = [
    {
      target: "pino-roll",
      level,
      options: {
        file: join(dir, "agent-connect.log"),
        frequency: "daily",
        dateFormat: "yyyy-MM-dd",
        mkdir: true,
        size: "50m",
        // `current.log` symlink → active file. Survives rotations so
        // `tail -f current.log` keeps working.
        symlink: true,
        // Retention: keep 30 rotated files + the active one. Bounds disk
        // usage at ~30 × 50 MB = 1.5 GB worst case.
        limit: { count: 30 }
      }
    }
  ];

  if (process.env.AGENT_CONNECT_LOG_STDOUT === "1") {
    targets.push({
      target: "pino/file",
      level,
      options: { destination: 1 }
    });
  }

  return pino(
    {
      level,
      base: { service: "agent-connect", pid: process.pid }
    },
    pino.transport({ targets })
  );
}
