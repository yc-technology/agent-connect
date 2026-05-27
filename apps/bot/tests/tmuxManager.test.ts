import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/agent-connect/config.js";
import { TmuxManager } from "../src/agent-connect/tmuxManager.js";
import { installCaptureLogger } from "./helpers/testLogger.js";

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
          "#{window_id}"
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

describe("TmuxManager.listWindowsAuthoritative probe-based listing", () => {
  type ProbeResult = { code: number; stdout: string; stderr: string };
  function tmuxManagerWithProbe(
    responder: (args: string[]) => ProbeResult
  ): { manager: TmuxManager; calls: string[][] } {
    const manager = new TmuxManager({
      tmuxSessionName: "agent-connect",
      tmuxMainWindowName: "__main__",
      agentType: "claude",
      claudeCommand: "claude"
    } as Config);
    const calls: string[][] = [];
    (manager as unknown as { execTmux: ExecTmux }).execTmux = async (args) => {
      calls.push(args);
      return responder(args);
    };
    return { manager, calls };
  }

  it("fetches ids via single-field list then probes each via display-message", async () => {
    const { manager, calls } = tmuxManagerWithProbe((args) => {
      if (args[0] === "list-windows") {
        return { code: 0, stdout: "@0\n@5\n@12\n", stderr: "" };
      }
      if (args[0] === "display-message") {
        const id = args[2];
        if (id === "@0") return { code: 0, stdout: "__main__\n/Users/foo\nzsh\n", stderr: "" };
        if (id === "@5") return { code: 0, stdout: "proj\n/Users/foo/proj\nclaude\n", stderr: "" };
        if (id === "@12") return { code: 0, stdout: "\n/Users/foo/empty-name\nbash\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });

    const result = await manager.listWindowsAuthoritative();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // __main__ is the session's main window — filtered out.
    expect(result.windows).toEqual([
      { windowId: "@5", windowName: "proj", cwd: "/Users/foo/proj", paneCurrentCommand: "claude" },
      { windowId: "@12", windowName: "", cwd: "/Users/foo/empty-name", paneCurrentCommand: "bash" }
    ]);
    // List-windows is single-field; no `\t` to lose.
    expect(calls[0]).toEqual([
      "list-windows", "-t", "agent-connect", "-F", "#{window_id}"
    ]);
    // Each probe uses newline-separated format inside display-message.
    expect(calls[1]).toEqual([
      "display-message", "-t", "@0", "-p",
      "#{window_name}\n#{pane_current_path}\n#{pane_current_command}"
    ]);
  });

  it("skips a window whose display-message probe fails (e.g. closed mid-list)", async () => {
    const log = installCaptureLogger();
    const { manager } = tmuxManagerWithProbe((args) => {
      if (args[0] === "list-windows") {
        return { code: 0, stdout: "@7\n@8\n", stderr: "" };
      }
      if (args[0] === "display-message") {
        const id = args[2];
        if (id === "@7") {
          return { code: 1, stdout: "", stderr: "can't find window: @7" };
        }
        return { code: 0, stdout: "live\n/Users/foo\nzsh\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });

    const result = await manager.listWindowsAuthoritative();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.windows).toEqual([
      { windowId: "@8", windowName: "live", cwd: "/Users/foo", paneCurrentCommand: "zsh" }
    ]);
    const warns = log.at("warn").filter((r) => r.msg?.includes("display-message probe failed"));
    expect(warns).toHaveLength(1);
    expect(warns[0]?.windowId).toBe("@7");
  });

  it("returns ok:false when list-windows itself fails (tmux unreachable)", async () => {
    const { manager } = tmuxManagerWithProbe(() => ({
      code: 1,
      stdout: "",
      stderr: "no server running on /tmp/tmux"
    }));

    const result = await manager.listWindowsAuthoritative();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("tmux-unreachable");
  });
});
