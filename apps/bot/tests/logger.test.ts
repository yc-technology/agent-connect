import { describe, expect, it, afterEach } from "vitest";
import { logger, setLoggerForTesting } from "../src/agent-connect/logger.js";
import { installCaptureLogger } from "./helpers/testLogger.js";

afterEach(() => {
  setLoggerForTesting(null);
});

describe("logger", () => {
  it("returns a silent pino in test env so vitest output stays clean", () => {
    // Vitest sets VITEST=true; buildLogger() returns level=silent in that env.
    // We can verify by clearing any installed test override and reading the
    // current effective level.
    setLoggerForTesting(null);
    const l = logger();
    expect(l.level).toBe("silent");
  });

  it("setLoggerForTesting / installCaptureLogger round-trips messages", () => {
    const handle = installCaptureLogger();
    try {
      logger().info({ foo: "bar", n: 42 }, "hello world");
      logger().warn({ where: "test" }, "be careful");
      logger().error({ kind: "crash" }, "the sky is falling");

      const infos = handle.at("info");
      expect(infos).toContainEqual(expect.objectContaining({ level: 30, msg: "hello world", foo: "bar", n: 42 }));

      const warns = handle.at("warn");
      // Includes the error record too (warn-and-above).
      expect(warns.find((r) => r.msg === "be careful")).toMatchObject({ where: "test" });
      expect(warns.find((r) => r.msg === "the sky is falling")).toMatchObject({ kind: "crash" });

      // `at("error")` is a stricter filter — only error+ records.
      expect(handle.at("error").every((r) => r.level >= 50)).toBe(true);
    } finally {
      handle.restore();
    }
  });

  it("restore() releases the override so a follow-up logger() call returns the silent default again", () => {
    const handle = installCaptureLogger();
    logger().info({}, "captured");
    expect(handle.records.length).toBe(1);
    handle.restore();
    // After restore, logger() rebuilds from the env and goes silent in test mode.
    expect(logger().level).toBe("silent");
  });
});
