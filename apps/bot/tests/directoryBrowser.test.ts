import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSE_DIRS_KEY,
  BROWSE_PAGE_KEY,
  BROWSE_PATH_KEY,
  buildDirectoryBrowser,
  buildSessionPicker,
  buildWindowPicker,
  clearBrowseState,
  DIRS_PER_PAGE,
  STATE_KEY,
  UNBOUND_WINDOWS_KEY
} from "../src/agent-connect/directoryBrowser.js";

function callbackData(button: unknown): string | undefined {
  return (button as { callback_data?: string }).callback_data;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-connect-browser-test-"));
}

describe("directory browser", () => {
  it("builds a paginated directory picker and hides dot dirs by default", () => {
    const dir = tmpDir();
    try {
      for (let i = 0; i < DIRS_PER_PAGE + 1; i += 1) mkdirSync(join(dir, `dir-${i}`));
      mkdirSync(join(dir, ".hidden"));

      const result = buildDirectoryBrowser(dir);

      expect(result.text).toContain("Select Working Directory");
      expect(result.subdirs).not.toContain(".hidden");
      expect(result.keyboard.inline_keyboard.flat().some((button) => callbackData(button) === "db:page:1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can include hidden directories", () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, ".hidden"));
      const result = buildDirectoryBrowser(dir, 0, { showHiddenDirs: true });
      expect(result.subdirs).toContain(".hidden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a window picker with cached window ids", () => {
    const result = buildWindowPicker([
      { windowId: "@1", windowName: "api", cwd: "/tmp/api" },
      { windowId: "@2", windowName: "worker", cwd: "/tmp/worker" }
    ]);

    expect(result.windowIds).toEqual(["@1", "@2"]);
    expect(result.text).toContain("Bind to Existing Window");
    expect(result.keyboard.inline_keyboard.flat().map(callbackData)).toContain("wb:sel:0");
  });

  it("builds a session picker with relative timestamps", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, "{}\n", "utf8");

      const result = buildSessionPicker(
        [{ sessionId: "s1", summary: "Implement feature", messageCount: 3, filePath: file }],
        { nowMs: Date.now() }
      );

      expect(result.text).toContain("Resume Session");
      expect(result.text).toContain("3 msgs");
      expect(result.keyboard.inline_keyboard.flat().map(callbackData)).toContain("rs:sel:0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears browse state keys", () => {
    const userData: Record<string, unknown> = {
      [STATE_KEY]: "browsing_directory",
      [BROWSE_PATH_KEY]: "/tmp",
      [BROWSE_PAGE_KEY]: 1,
      [BROWSE_DIRS_KEY]: ["src"],
      [UNBOUND_WINDOWS_KEY]: ["@1"]
    };

    clearBrowseState(userData);

    expect(userData).toEqual({ [UNBOUND_WINDOWS_KEY]: ["@1"] });
  });
});
