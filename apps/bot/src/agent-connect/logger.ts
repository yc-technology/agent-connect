import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { agentConnectDir } from "./utils.js";

/**
 * Shared structured logger for the bot service.
 *
 * Default destination: `$AGENT_CONNECT_DIR/logs/agent-connect.log` with
 * daily rotation via `pino-roll`. Old days are kept as
 * `agent-connect.log.YYYY-MM-DD`. A 50 MB size cap also triggers rotation
 * within a single day so a runaway loop can't fill the disk before
 * midnight.
 *
 * Env knobs:
 *   - `AGENT_CONNECT_LOG_LEVEL`  default `info`. One of pino's
 *      `trace|debug|info|warn|error|fatal|silent`.
 *   - `AGENT_CONNECT_LOG_STDOUT=1` also mirror to stdout (useful during
 *      `pnpm dev:bot` so you can tail in the terminal AND have a file).
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
        size: "50m"
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
