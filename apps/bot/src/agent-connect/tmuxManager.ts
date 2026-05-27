import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { agentLabel, buildAgentCommand } from "./claudeCommand.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Scrollback rows pulled in addition to the visible viewport on every
 * `capturePane`. Tall AskUserQuestion pickers (long option descriptions) push
 * their `☐` top marker above the visible area; without scrollback, the picker
 * is silently invisible to terminalParser and `handleInteractiveUi` never
 * fires. 200 covers every Claude/Codex overlay we've observed with margin and
 * costs ~30 KB of pane text per tick — negligible.
 */
const PANE_SCROLLBACK_LINES = 200;

export interface TmuxWindow {
  windowId: string;
  windowName: string;
  cwd: string;
  paneCurrentCommand: string;
}

/**
 * Authoritative result of asking tmux for the list of windows in our session.
 *
 * `ok: false` is NOT the same as `windows: []`. The latter means "tmux is up,
 * session exists, just no windows except the main one we filter out"; the
 * former means we could not get an authoritative answer at all (server
 * unreachable / session vanished / exec error). Callers that base destructive
 * actions on absence — see statusPolling.ts cleanupTopicBinding — must check
 * `ok` first, otherwise a transient tmux outage looks identical to "all
 * windows died" and silently wipes the bot DB via FK CASCADE.
 */
export type ListWindowsResult =
  | { ok: true; windows: TmuxWindow[] }
  | {
      ok: false;
      reason: "tmux-unreachable" | "session-missing" | "exec-failed";
      detail: string;
    };

export interface CreateWindowOptions {
  windowName?: string | null;
  startClaude?: boolean;
  resumeSessionId?: string | null;
}

export class TmuxManager {
  constructor(private readonly config: Config) {}

  async getSessionExists(): Promise<boolean> {
    const result = await this.execTmux(["has-session", "-t", this.config.tmuxSessionName], {
      rejectOnError: false
    });
    return result.code === 0;
  }

  async getOrCreateSession(): Promise<void> {
    if (await this.getSessionExists()) {
      await this.scrubSessionEnv();
      return;
    }

    await this.execTmux([
      "new-session",
      "-d",
      "-s",
      this.config.tmuxSessionName,
      "-c",
      process.env.HOME ?? "."
    ]);
    await this.execTmux([
      "rename-window",
      "-t",
      this.config.tmuxSessionName,
      this.config.tmuxMainWindowName
    ]);
    await this.scrubSessionEnv();
  }

  async listWindowsAuthoritative(): Promise<ListWindowsResult> {
    // Probe-based listing. A user's deployment was observed producing
    // mangled multi-field `-F` rows where the `\t` separators between
    // fields didn't survive — the picker showed
    // `@0\tmain\t/Users/.../workspace_zsh` as one giant concatenated
    // windowId, and every downstream `-t <id>` op failed because no
    // real window had that id. Root cause unknown (tmux version /
    // locale / shell wrapper / encoding quirk); root-cause-fixing it
    // is brittle anyway since we can't enumerate every broken setup.
    //
    // Instead: do not parse multi-field output. Single-field calls
    // can't be mis-split. We get the canonical ID list in one call,
    // then probe each id individually for metadata using `display-message`.
    // N+1 tmux execs per refresh; tmux IPC is local and sub-ms, and the
    // poll cadence is 1-2s, so the cost is fine.
    const idResult = await this.execTmux(
      [
        "list-windows",
        "-t",
        this.config.tmuxSessionName,
        "-F",
        "#{window_id}"
      ],
      { rejectOnError: false }
    );

    if (idResult.code !== 0) {
      const stderr = idResult.stderr.trim();
      const lower = stderr.toLowerCase();
      let reason: "tmux-unreachable" | "session-missing" | "exec-failed" = "exec-failed";
      if (lower.includes("no server running") || lower.includes("error connecting")) {
        reason = "tmux-unreachable";
      } else if (lower.includes("can't find session") || lower.includes("session not found")) {
        reason = "session-missing";
      }
      return {
        ok: false,
        reason,
        detail: stderr || `tmux list-windows exit ${idResult.code}`
      };
    }

    const windowIds = idResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const windows: TmuxWindow[] = [];
    for (const windowId of windowIds) {
      // Per-window probe. Newline as field separator inside `-p` is
      // safer than `\t` — newlines are fundamental to terminal I/O,
      // anything that swallows them would have broken `list-windows`
      // line splitting too. If the probe fails (window vanished
      // between the list call and the probe, or tmux gives some
      // unexpected output), skip the row + warn.
      const meta = await this.execTmux(
        [
          "display-message",
          "-t",
          windowId,
          "-p",
          "#{window_name}\n#{pane_current_path}\n#{pane_current_command}"
        ],
        { rejectOnError: false }
      );
      if (meta.code !== 0) {
        logger().warn(
          {
            tmuxSession: this.config.tmuxSessionName,
            windowId,
            stderr: meta.stderr.trim()
          },
          "tmux display-message probe failed; skipping window"
        );
        continue;
      }
      const lines = meta.stdout.split("\n");
      const windowName = (lines[0] ?? "").trimEnd();
      const cwd = (lines[1] ?? "").trimEnd();
      const paneCurrentCommand = (lines[2] ?? "").trimEnd();
      if (windowName === this.config.tmuxMainWindowName) continue;
      windows.push({ windowId, windowName, cwd, paneCurrentCommand });
    }

    return { ok: true, windows };
  }

  // Convenience wrapper kept for user-triggered paths (commands, REST handlers)
  // that just want a list and treat any failure as "nothing to show". Hot paths
  // like statusPolling.tick MUST call listWindowsAuthoritative directly so they
  // can distinguish "tmux is down" from "session has no windows" before doing
  // anything destructive.
  async listWindows(): Promise<TmuxWindow[]> {
    const result = await this.listWindowsAuthoritative();
    return result.ok ? result.windows : [];
  }

  async findWindowById(windowId: string): Promise<TmuxWindow | null> {
    const windows = await this.listWindows();
    return windows.find((window) => window.windowId === windowId) ?? null;
  }

  async findWindowByName(windowName: string): Promise<TmuxWindow | null> {
    const windows = await this.listWindows();
    return windows.find((window) => window.windowName === windowName) ?? null;
  }

  async capturePane(windowId: string, withAnsi = false): Promise<string | null> {
    const args = ["capture-pane"];
    if (withAnsi) args.push("-e");
    args.push("-S", `-${PANE_SCROLLBACK_LINES}`, "-p", "-t", windowId);

    const result = await this.execTmux(args, { rejectOnError: false });
    return result.code === 0 ? result.stdout : null;
  }

  async sendKeys(
    windowId: string,
    text: string,
    options: { enter?: boolean; literal?: boolean } = {}
  ): Promise<boolean> {
    const enter = options.enter ?? true;
    const literal = options.literal ?? true;

    if (literal) {
      if (text) {
        if (enter && text.startsWith("!")) {
          if (!(await this.sendLiteral(windowId, "!"))) return false;
          const rest = text.slice(1);
          if (rest) {
            await sleep(1000);
            if (!(await this.sendLiteral(windowId, rest))) return false;
          }
        } else if (!(await this.sendLiteral(windowId, text))) {
          return false;
        }
      }
      if (!enter) return true;
      await sleep(500);
      const result = await this.execTmux(["send-keys", "-t", windowId, "Enter"], {
        rejectOnError: false
      });
      return result.code === 0;
    }

    const args = ["send-keys", "-t", windowId];
    args.push(text);
    if (enter) args.push("Enter");

    const result = await this.execTmux(args, { rejectOnError: false });
    return result.code === 0;
  }

  async killWindow(windowId: string): Promise<boolean> {
    const result = await this.execTmux(["kill-window", "-t", windowId], {
      rejectOnError: false
    });
    if (result.code === 0) {
      logger().info({ windowId, tmuxSession: this.config.tmuxSessionName }, "tmux window killed");
    } else {
      logger().warn(
        { windowId, tmuxSession: this.config.tmuxSessionName, stderr: result.stderr.trim() },
        "tmux window kill failed"
      );
    }
    return result.code === 0;
  }

  async renameWindow(windowId: string, newName: string): Promise<boolean> {
    const result = await this.execTmux(["rename-window", "-t", windowId, newName], {
      rejectOnError: false
    });
    return result.code === 0;
  }

  async createWindow(
    workDir: string,
    options: CreateWindowOptions = {}
  ): Promise<[boolean, string, string, string]> {
    const path = resolve(workDir);
    if (!existsSync(path)) {
      return [false, `Directory does not exist: ${workDir}`, "", ""];
    }
    if (!statSync(path).isDirectory()) {
      return [false, `Not a directory: ${workDir}`, "", ""];
    }

    const baseName = options.windowName || basename(path) || "session";
    let finalWindowName = baseName;
    let counter = 2;
    while (await this.findWindowByName(finalWindowName)) {
      finalWindowName = `${baseName}-${counter}`;
      counter += 1;
    }

    const created = await this.execTmux(
      [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        this.config.tmuxSessionName,
        "-n",
        finalWindowName,
        "-c",
        path
      ],
      { rejectOnError: false }
    );
    if (created.code !== 0) {
      return [false, `Failed to create window: ${created.stderr || created.stdout}`.trim(), "", ""];
    }

    const windowId = created.stdout.trim();
    if (!windowId) {
      return [false, "Failed to create window: tmux did not return a window id", "", ""];
    }

    await this.execTmux(["set-window-option", "-t", windowId, "allow-rename", "off"], {
      rejectOnError: false
    });

	    if (options.startClaude ?? true) {
	      const command = buildAgentCommand(this.config.agentType, this.config.claudeCommand, {
	        resumeSessionId: options.resumeSessionId
	      });
	      const sent = await this.sendKeys(windowId, command);
	      if (!sent) {
	        return [false, `Failed to start ${agentLabel(this.config.agentType)} in new window`, finalWindowName, windowId];
	      }
	    }

    logger().info(
      {
        windowId,
        windowName: finalWindowName,
        cwd: path,
        tmuxSession: this.config.tmuxSessionName,
        agentType: this.config.agentType,
        resumeSessionId: options.resumeSessionId ?? null
      },
      "tmux window created"
    );
    return [
      true,
      `Created window '${finalWindowName}' at ${path}`,
      finalWindowName,
      windowId
    ];
  }

  private async scrubSessionEnv(): Promise<void> {
    for (const name of ["TELEGRAM_BOT_TOKEN", "ALLOWED_USERS", "OPENAI_API_KEY"]) {
      await this.execTmux(
        ["set-environment", "-t", this.config.tmuxSessionName, "-u", name],
        { rejectOnError: false }
      );
    }
  }

  private async sendLiteral(windowId: string, text: string): Promise<boolean> {
    const result = await this.execTmux(["send-keys", "-t", windowId, "-l", text], {
      rejectOnError: false
    });
    return result.code === 0;
  }

  private async execTmux(
    args: string[],
    options: { rejectOnError?: boolean } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("tmux", args, {
        encoding: "utf8"
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      if (options.rejectOnError ?? true) {
        throw error;
      }
      return {
        code: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
