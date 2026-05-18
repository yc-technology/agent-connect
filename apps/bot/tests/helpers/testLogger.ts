import pino, { type Logger } from "pino";
import { setLoggerForTesting } from "../../src/agent-connect/logger.js";

export interface CapturedLog {
  level: number; // pino numeric: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
  msg: string;
  [key: string]: unknown;
}

export interface TestLoggerHandle {
  logger: Logger;
  records: CapturedLog[];
  /** Records whose numeric level >= the named threshold. */
  at(name: "trace" | "debug" | "info" | "warn" | "error" | "fatal"): CapturedLog[];
  restore(): void;
}

/**
 * Install a capture pino instance as the global singleton and return its
 * record buffer. Callers MUST invoke `restore()` (e.g. in `afterEach` or
 * a `finally`) to release the override so other tests aren't infected.
 */
export function installCaptureLogger(level: "trace" | "debug" | "info" = "trace"): TestLoggerHandle {
  const records: CapturedLog[] = [];
  const stream = {
    write(s: string): void {
      try {
        records.push(JSON.parse(s) as CapturedLog);
      } catch {
        // Non-JSON write (e.g. pretty mode). Ignore — capture logger is
        // always plain JSON, so this only fires under unexpected configs.
      }
    }
  };
  const logger = pino({ level }, stream);
  setLoggerForTesting(logger);
  return {
    logger,
    records,
    at(name): CapturedLog[] {
      const min = LEVELS[name];
      return records.filter((r) => typeof r.level === "number" && r.level >= min);
    },
    restore(): void {
      setLoggerForTesting(null);
    }
  };
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
