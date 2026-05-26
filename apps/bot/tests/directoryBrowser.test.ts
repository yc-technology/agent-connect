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

  it("window picker substitutes fallback for empty windowName and cwd", () => {
    // Reported in the wild (林老师's TG setup): a tmux window with empty
    // windowName + empty cwd rendered as `• \`\` — ` — the empty backticks
    // don't form a code entity so they show as literal characters in TG,
    // and the trailing em-dash sits alone with no path. Defend with
    // explicit "(unnamed)" / "(no cwd)" fallback so the row stays readable.
    const result = buildWindowPicker([
      { windowId: "@7", windowName: "", cwd: "" }
    ]);
    expect(result.text).toContain("(unnamed @7)");
    expect(result.text).toContain("(no cwd)");
    // No bare ``  literal backtick pair (would mean code entity collapsed).
    expect(result.text).not.toMatch(/`` /);
    // Keyboard label likewise uses fallback, not empty truncate.
    const labels = result.keyboard.inline_keyboard
      .flat()
      .map((b) => (b as { text?: string }).text ?? "");
    expect(labels.some((l) => l.includes("(unnamed @7)"))).toBe(true);
  });

  it("window picker escapes backticks inside windowName", () => {
    // Defense in depth: if a windowName ever contains a literal backtick
    // (someone named their tmux window with `tmux rename-window 'foo\`bar'`),
    // it would prematurely close our code span and leak the rest as plain
    // markdown. Escape with `\\\``.
    const result = buildWindowPicker([
      { windowId: "@1", windowName: "foo`bar", cwd: "/tmp" }
    ]);
    expect(result.text).toContain("foo\\`bar");
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

describe("buildSessionPicker recovery highlight", () => {
  const sessions = [
    { sessionId: "sess-aaa", summary: "first task", messageCount: 12, filePath: "/tmp/a.jsonl" },
    { sessionId: "sess-bbb", summary: "second task", messageCount: 7, filePath: "/tmp/b.jsonl" },
    { sessionId: "sess-ccc", summary: "third task", messageCount: 3, filePath: "/tmp/c.jsonl" }
  ];

  it("renders no marker when recommendedSessionId is omitted", () => {
    const picker = buildSessionPicker(sessions);
    expect(picker.text).not.toContain("★");
    expect(picker.text).not.toContain("(previous)");
    // Default ▶ on every button.
    const labels = picker.keyboard.inline_keyboard
      .flat()
      .map((b) => (b as { text?: string }).text ?? "");
    expect(labels.filter((l) => l.startsWith("▶ ")).length).toBe(sessions.length);
    expect(labels.filter((l) => l.startsWith("★ ")).length).toBe(0);
  });

  it("prefixes ★ on the matched row + tags '(previous)' in the list", () => {
    const picker = buildSessionPicker(sessions, { recommendedSessionId: "sess-bbb" });
    // Exactly one row gets the recovery marker.
    expect(picker.text.match(/★ /g)?.length).toBe(1);
    expect(picker.text).toContain("★ 2. second task");
    expect(picker.text).toContain("_(previous)_");
    // Only the matched row's button gets ★; others stay ▶.
    const labels = picker.keyboard.inline_keyboard
      .flat()
      .map((b) => (b as { text?: string }).text ?? "");
    expect(labels.filter((l) => l.startsWith("★ ")).length).toBe(1);
    expect(labels.find((l) => l.startsWith("★ "))).toContain("second task");
  });

  it("non-matching recommendedSessionId leaves all rows as default ▶", () => {
    const picker = buildSessionPicker(sessions, { recommendedSessionId: "sess-zzz" });
    expect(picker.text).not.toContain("★");
    expect(picker.text).not.toContain("(previous)");
  });
});
