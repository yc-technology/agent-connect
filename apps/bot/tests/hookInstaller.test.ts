import { describe, test, expect } from "vitest";
import { syncHookSettings } from "../src/agent-connect/hookInstaller.js";

describe("syncHookSettings events parameter", () => {
  test("installs hook command under each named event", () => {
    const settings: Record<string, unknown> = {};
    syncHookSettings(settings, "agc hook", { events: ["SessionStart", "Stop", "PostToolUse"] });
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    expect(hooks.SessionStart).toBeTruthy();
    expect(hooks.Stop).toBeTruthy();
    expect(hooks.PostToolUse).toBeTruthy();
  });

  test("is idempotent — running twice produces same result", () => {
    const settings: Record<string, unknown> = {};
    syncHookSettings(settings, "agc hook", { events: ["SessionStart", "Stop"] });
    const snapshot = JSON.stringify(settings);
    syncHookSettings(settings, "agc hook", { events: ["SessionStart", "Stop"] });
    expect(JSON.stringify(settings)).toBe(snapshot);
  });

  test("preserves unrelated user hooks", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }]
      }
    };
    syncHookSettings(settings, "agc hook", { events: ["Stop"] });
    const stopEntries = (settings.hooks as Record<string, unknown[]>).Stop as Array<{
      hooks: Array<{ command: string }>;
    }>;
    const allCommands = stopEntries.flatMap((e) => e.hooks.map((h) => h.command));
    expect(allCommands).toContain("echo unrelated");
    expect(allCommands).toContain("agc hook");
  });

  test("applies matcher option only to first entry when given", () => {
    const settings: Record<string, unknown> = {};
    syncHookSettings(settings, "agc hook", {
      events: ["SessionStart"],
      matcher: "startup|resume|clear|compact"
    });
    const entries = (settings.hooks as Record<string, unknown[]>).SessionStart as Array<{
      matcher?: string;
    }>;
    expect(entries[0]?.matcher).toBe("startup|resume|clear|compact");
  });
});
