import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/agent-connect/config.js";
import { TmuxManager } from "../src/agent-connect/tmuxManager.js";

type ExecTmux = (
  args: string[],
  options?: { rejectOnError?: boolean }
) => Promise<{ code: number; stdout: string; stderr: string }>;

function tmuxManagerWithCalls(config: Partial<Config> = {}): { manager: TmuxManager; calls: string[][] } {
  const manager = new TmuxManager({
    tmuxSessionName: "agent-connect",
    tmuxMainWindowName: "__main__",
    agentType: "claude",
    claudeCommand: "claude",
    ...config
  } as Config);
  const calls: string[][] = [];
  (manager as unknown as { execTmux: ExecTmux }).execTmux = async (args) => {
    calls.push(args);
    if (args[0] === "new-window") return { code: 0, stdout: "@9\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { manager, calls };
}

describe("TmuxManager.sendKeys", () => {
  it("sends literal text and Enter as separate tmux commands", async () => {
    vi.useFakeTimers();
    try {
      const { manager, calls } = tmuxManagerWithCalls();
      const sent = manager.sendKeys("@1", "hello", { literal: true, enter: true });

      await vi.advanceTimersByTimeAsync(500);

      await expect(sent).resolves.toBe(true);
      expect(calls).toEqual([
        ["send-keys", "-t", "@1", "-l", "hello"],
        ["send-keys", "-t", "@1", "Enter"]
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the command-mode delay after a leading bang", async () => {
    vi.useFakeTimers();
    try {
      const { manager, calls } = tmuxManagerWithCalls();
      const sent = manager.sendKeys("@1", "!help", { literal: true, enter: true });

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(500);

      await expect(sent).resolves.toBe(true);
      expect(calls).toEqual([
        ["send-keys", "-t", "@1", "-l", "!"],
        ["send-keys", "-t", "@1", "-l", "help"],
        ["send-keys", "-t", "@1", "Enter"]
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renames a window by id", async () => {
    const { manager, calls } = tmuxManagerWithCalls();

    await expect(manager.renameWindow("@1", "new-name")).resolves.toBe(true);

    expect(calls).toEqual([["rename-window", "-t", "@1", "new-name"]]);
  });

  it("creates a tmux window without starting Claude when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-tmux-test-"));
    try {
      const { manager, calls } = tmuxManagerWithCalls();

      await expect(manager.createWindow(dir, { startClaude: false, windowName: "proj" })).resolves.toEqual([
        true,
        `Created window 'proj' at ${dir}`,
        "proj",
        "@9"
      ]);

      expect(calls).toEqual([
        [
          "list-windows",
          "-t",
          "agent-connect",
          "-F",
          "#{window_id}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}"
        ],
        [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id}",
          "-t",
          "agent-connect",
          "-n",
          "proj",
          "-c",
          dir
        ],
        ["set-window-option", "-t", "@9", "allow-rename", "off"]
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts Claude with bypass permission mode by default", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-tmux-test-"));
    try {
      const { manager, calls } = tmuxManagerWithCalls();
      const created = manager.createWindow(dir, { windowName: "proj" });

      await vi.advanceTimersByTimeAsync(500);

      await expect(created).resolves.toEqual([
        true,
        `Created window 'proj' at ${dir}`,
        "proj",
        "@9"
      ]);
      expect(calls).toContainEqual([
        "send-keys",
        "-t",
        "@9",
        "-l",
        "claude --permission-mode bypassPermissions"
      ]);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves explicit permission mode when resuming Claude", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-tmux-test-"));
    try {
      const { manager, calls } = tmuxManagerWithCalls();
      (manager as unknown as { config: Config }).config = {
        tmuxSessionName: "agent-connect",
        tmuxMainWindowName: "__main__",
        agentType: "claude",
        claudeCommand: "claude --permission-mode ask"
      } as Config;
      const created = manager.createWindow(dir, {
        windowName: "proj",
        resumeSessionId: "session-123"
      });

      await vi.advanceTimersByTimeAsync(500);

      await expect(created).resolves.toEqual([
        true,
        `Created window 'proj' at ${dir}`,
        "proj",
        "@9"
      ]);
      expect(calls).toContainEqual([
        "send-keys",
        "-t",
        "@9",
        "-l",
        "claude --permission-mode ask --resume session-123"
      ]);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts and resumes Codex with yolo enabled", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-tmux-test-"));
    try {
      const { manager, calls } = tmuxManagerWithCalls({
        agentType: "codex",
        claudeCommand: "codex"
      } as Partial<Config>);
      const created = manager.createWindow(dir, {
        windowName: "proj",
        resumeSessionId: "019e3004-fe4c-7cc1-88a5-4d253ac1cf93"
      });

      await vi.advanceTimersByTimeAsync(500);

      await expect(created).resolves.toEqual([
        true,
        `Created window 'proj' at ${dir}`,
        "proj",
        "@9"
      ]);
      expect(calls).toContainEqual([
        "send-keys",
        "-t",
        "@9",
        "-l",
        "codex --yolo resume 019e3004-fe4c-7cc1-88a5-4d253ac1cf93"
      ]);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
