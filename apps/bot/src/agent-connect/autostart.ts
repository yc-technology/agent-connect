import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { agentConnectDir } from "./utils.js";

const execFileAsync = promisify(execFile);

/**
 * launchd LaunchAgent integration so the daemon comes back automatically after
 * a machine reboot / re-login.
 *
 * Model: **ignition only.** The plist fires `agc start --daemon` once at login
 * (`RunAtLoad=true`, `KeepAlive=false`). Our own supervisor then owns keepalive
 * (healthz probe + crash-loop backstop) exactly as it does for a manual
 * `agc start --daemon`. We deliberately do NOT let launchd KeepAlive the
 * process — that would double-supervise and fight the anti-double-start
 * tcpProbe (which exits code 2 on a stale listener), producing a relaunch
 * loop. One launchd ignition + one of our supervisors is the whole design.
 */

export const AUTOSTART_LABEL = "com.yc-tech.agent-connect";

export function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
}

export interface AutostartParams {
  /** Absolute path to the node binary (process.execPath). */
  nodePath: string;
  /** Absolute path to the agc CLI entry script (process.argv[1]). */
  cliEntry: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * PATH for the launchd job. launchd starts with a bare PATH that usually lacks
 * Homebrew — and the bot shells out to `tmux`, so a missing `/opt/homebrew/bin`
 * means every tmux call fails silently. Prepend the node dir + the common bin
 * dirs, then append the installer's current PATH so anything the user relies on
 * is preserved. Deduped, order-preserving.
 */
function buildPath(nodePath: string, env: NodeJS.ProcessEnv): string {
  const parts = [
    dirname(nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...(env.PATH ? env.PATH.split(":") : [])
  ];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of parts) {
    if (part && !seen.has(part)) {
      seen.add(part);
      deduped.push(part);
    }
  }
  return deduped.join(":");
}

export function renderPlist(params: AutostartParams): string {
  const env = params.env ?? process.env;
  const home = params.home ?? homedir();
  const dir = agentConnectDir(env);
  const logsDir = join(dir, "logs");

  // Propagate every AGENT_CONNECT_* knob the installer is currently running
  // with, so the launchd-started daemon matches the user's manual config
  // (port, config dir, db file, telegram toggle, …). PATH is computed
  // separately because launchd's default is too bare to find tmux.
  const envVars: Record<string, string> = { PATH: buildPath(params.nodePath, env) };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("AGENT_CONNECT_") && typeof value === "string") {
      envVars[key] = value;
    }
  }

  const envXml = Object.entries(envVars)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(params.nodePath)}</string>
    <string>${xmlEscape(params.cliEntry)}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logsDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logsDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

async function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, { encoding: "utf8" });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (err.stderr || err.stdout || err.message || "").trim() };
  }
}

export interface AutostartResult {
  ok: boolean;
  message: string;
  path: string;
}

export async function installAutostart(params: AutostartParams): Promise<AutostartResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      path: "",
      message:
        "Auto-start via launchd is only supported on macOS. On Linux, use a systemd user service running `agc start --daemon`."
    };
  }

  const home = params.home ?? homedir();
  const target = plistPath(home);
  const env = params.env ?? process.env;

  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(join(agentConnectDir(env), "logs"), { recursive: true });

  // Unload any prior copy first so a re-install picks up new ProgramArguments
  // / env. Ignore failure (not loaded yet on first install).
  await launchctl(["unload", target]);

  writeFileSync(target, renderPlist({ ...params, home }), "utf8");

  const loaded = await launchctl(["load", "-w", target]);
  if (!loaded.ok) {
    return {
      ok: false,
      path: target,
      message: `Wrote ${target} but \`launchctl load\` failed: ${loaded.output || "unknown error"}`
    };
  }

  return {
    ok: true,
    path: target,
    message:
      `Installed launchd auto-start at ${target}.\n` +
      "The daemon now starts automatically at login. It also started just now\n" +
      "(if one wasn't already running). Verify with `agc status`."
  };
}

export async function uninstallAutostart(home = homedir()): Promise<AutostartResult> {
  if (process.platform !== "darwin") {
    return { ok: false, path: "", message: "Auto-start via launchd is only supported on macOS." };
  }
  const target = plistPath(home);
  if (!existsSync(target)) {
    return { ok: true, path: target, message: "Auto-start was not installed (nothing to remove)." };
  }
  await launchctl(["unload", "-w", target]);
  rmSync(target, { force: true });
  return {
    ok: true,
    path: target,
    message:
      `Removed launchd auto-start (${target}). The daemon will no longer start at login.\n` +
      "A currently-running daemon is left untouched — use `agc stop` to stop it."
  };
}

export async function autostartStatus(home = homedir()): Promise<AutostartResult> {
  if (process.platform !== "darwin") {
    return { ok: false, path: "", message: "Auto-start via launchd is only supported on macOS." };
  }
  const target = plistPath(home);
  if (!existsSync(target)) {
    return { ok: false, path: target, message: "Auto-start: NOT installed. Run `agc autostart` to enable." };
  }
  const listed = await launchctl(["list", AUTOSTART_LABEL]);
  const loaded = listed.ok ? "loaded" : "installed but not currently loaded";
  return {
    ok: true,
    path: target,
    message: `Auto-start: installed (${loaded}).\n  plist: ${target}`
  };
}
