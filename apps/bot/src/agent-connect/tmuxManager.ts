import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { agentLabel, buildAgentCommand } from "./claudeCommand.js";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface TmuxWindow {
  windowId: string;
  windowName: string;
  cwd: string;
  paneCurrentCommand: string;
}

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

  async listWindows(): Promise<TmuxWindow[]> {
    const format = [
      "#{window_id}",
      "#{window_name}",
      "#{pane_current_path}",
      "#{pane_current_command}"
    ].join("\t");
    const result = await this.execTmux([
      "list-windows",
      "-t",
      this.config.tmuxSessionName,
      "-F",
      format
    ], { rejectOnError: false });

    if (result.code !== 0) return [];

    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [windowId = "", windowName = "", cwd = "", paneCurrentCommand = ""] =
          line.split("\t");
        return { windowId, windowName, cwd, paneCurrentCommand };
      })
      .filter((window) => window.windowName !== this.config.tmuxMainWindowName);
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
    args.push("-p", "-t", windowId);

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
