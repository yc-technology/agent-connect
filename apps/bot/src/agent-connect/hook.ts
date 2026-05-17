import { constants, existsSync } from "node:fs";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, delimiter, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { botConfigDir } from "./botConfig.js";
import { atomicWriteJson, agentConnectDir } from "./utils.js";

const execFileAsync = promisify(execFile);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HOOK_COMMAND_SUFFIX = "agc hook";
export const HOOK_COMMAND_SUFFIXES = [HOOK_COMMAND_SUFFIX, "ccbot hook", "ccbot-ts hook"] as const;
const AGENT_CONNECT_BIN_NAMES = ["agc"] as const;

export interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

export interface HookProcessOptions {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  displayMessage?: (paneId: string) => Promise<string>;
}

export interface InstallHookOptions {
  settingsFile?: string;
  hookCommand?: string;
  env?: NodeJS.ProcessEnv;
  entrypoint?: string;
}

export interface InstallCodexHookOptions {
  hooksFile?: string;
  configFile?: string;
  hookCommand?: string;
  env?: NodeJS.ProcessEnv;
  entrypoint?: string;
}

export interface InstallAllHooksOptions {
  settingsFile?: string;
  codexHooksFile?: string;
  codexConfigFile?: string;
  hookCommand?: string;
  env?: NodeJS.ProcessEnv;
  entrypoint?: string;
}

export interface ResolveHookCommandOptions {
  env?: NodeJS.ProcessEnv;
  entrypoint?: string;
}

type JsonRecord = Record<string, unknown>;

export function isHookInstalled(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return false;
  const sessionStart = hooks.SessionStart;
  if (!Array.isArray(sessionStart)) return false;

  for (const entry of sessionStart) {
    if (!isRecord(entry)) continue;
    const innerHooks = entry.hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (const hook of innerHooks) {
      if (!isRecord(hook) || typeof hook.command !== "string") continue;
      if (isAgentConnectHookCommand(hook.command)) {
        return true;
      }
    }
  }
  return false;
}

export function isCodexHookInstalled(settings: unknown): boolean {
  return isHookInstalled(settings);
}

export async function installHook(options: InstallHookOptions = {}): Promise<{ code: number; message: string }> {
  const settingsFile = options.settingsFile ?? join(homedir(), ".claude", "settings.json");
  await mkdir(dirname(settingsFile), { recursive: true });

  let settings: JsonRecord = {};
  if (existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(await readFile(settingsFile, "utf8")) as unknown;
      settings = isRecord(parsed) ? parsed : {};
    } catch (error) {
      return {
        code: 1,
        message: `Error reading ${settingsFile}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const hookCommand =
    options.hookCommand ??
    (await resolveHookCommand(
      stripUndefined({
        env: options.env ?? process.env,
        entrypoint: options.entrypoint
      })
    ));
  const changed = syncHookSettings(settings, hookCommand);
  if (!changed) {
    return { code: 0, message: `Hook already synchronized in ${settingsFile}` };
  }

  try {
    await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    return {
      code: 1,
      message: `Error writing ${settingsFile}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  return { code: 0, message: `Hook synchronized in ${settingsFile}` };
}

export async function installCodexHook(options: InstallCodexHookOptions = {}): Promise<{ code: number; message: string }> {
  const codexDir = join(homedir(), ".codex");
  const hooksFile = options.hooksFile ?? join(codexDir, "hooks.json");
  const configFile = options.configFile ?? join(codexDir, "config.toml");
  await mkdir(dirname(hooksFile), { recursive: true });
  await mkdir(dirname(configFile), { recursive: true });

  let settings: JsonRecord = {};
  if (existsSync(hooksFile)) {
    try {
      const parsed = JSON.parse(await readFile(hooksFile, "utf8")) as unknown;
      settings = isRecord(parsed) ? parsed : {};
    } catch (error) {
      return {
        code: 1,
        message: `Error reading ${hooksFile}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const hookCommand =
    options.hookCommand ??
    (await resolveHookCommand(
      stripUndefined({
        env: options.env ?? process.env,
        entrypoint: options.entrypoint
      })
    ));
  const hooksChanged = syncHookSettings(settings, hookCommand, { matcher: "startup|resume|clear" });

  try {
    if (hooksChanged) {
      await writeFile(hooksFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    return {
      code: 1,
      message: `Error writing ${hooksFile}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let configChanged = false;
  try {
    const currentConfig = existsSync(configFile) ? await readFile(configFile, "utf8") : "";
    const nextConfig = syncCodexHooksFeatureFlag(currentConfig);
    configChanged = nextConfig !== currentConfig;
    if (configChanged) {
      await writeFile(configFile, nextConfig, "utf8");
    }
  } catch (error) {
    return {
      code: 1,
      message: `Error writing ${configFile}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!hooksChanged && !configChanged) {
    return { code: 0, message: `Codex hook already synchronized in ${hooksFile}` };
  }
  return { code: 0, message: `Codex hook synchronized in ${hooksFile}` };
}

export async function installAllHooks(options: InstallAllHooksOptions = {}): Promise<{ code: number; message: string }> {
  const hookCommand =
    options.hookCommand ??
    (await resolveHookCommand(
      stripUndefined({
        env: options.env ?? process.env,
        entrypoint: options.entrypoint
      })
    ));

  const claudeResult = await installHook(
    stripUndefined({
      settingsFile: options.settingsFile,
      hookCommand,
      env: options.env,
      entrypoint: options.entrypoint
    })
  );
  const codexResult = await installCodexHook(
    stripUndefined({
      hooksFile: options.codexHooksFile,
      configFile: options.codexConfigFile,
      hookCommand,
      env: options.env,
      entrypoint: options.entrypoint
    })
  );

  const code = claudeResult.code === 0 && codexResult.code === 0 ? 0 : 1;
  return {
    code,
    message: [`Claude: ${claudeResult.message}`, `Codex: ${codexResult.message}`].join("\n")
  };
}

export async function resolveHookCommand(options: ResolveHookCommandOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = env.AGENT_CONNECT_HOOK_COMMAND?.trim();
  if (explicit) return explicit.endsWith(" hook") ? explicit : `${explicit} hook`;

  const currentEntrypoint = options.entrypoint ?? process.argv[1];
  if (currentEntrypoint) {
    const name = basename(currentEntrypoint);
    if ((AGENT_CONNECT_BIN_NAMES as readonly string[]).includes(name)) {
      return HOOK_COMMAND_SUFFIX;
    }
    if (name === "main.js" || name === "index.js") {
      if (await findAgcPath(env)) return HOOK_COMMAND_SUFFIX;
      return `${shellQuote(process.execPath)} ${shellQuote(currentEntrypoint)} hook`;
    }
    if (name === "main.ts") {
      if (await findAgcPath(env)) return HOOK_COMMAND_SUFFIX;
      const appDir = dirname(dirname(dirname(currentEntrypoint)));
      return `cd ${shellQuote(appDir)} && pnpm exec tsx src/agent-connect/main.ts hook`;
    }
    if (name === "index.ts") {
      if (await findAgcPath(env)) return HOOK_COMMAND_SUFFIX;
      const packageDir = dirname(dirname(currentEntrypoint));
      return `cd ${shellQuote(packageDir)} && pnpm exec tsx src/index.ts hook`;
    }
  }

  return HOOK_COMMAND_SUFFIX;
}

export async function processHookEvent(payload: HookPayload, options: HookProcessOptions = {}): Promise<boolean> {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";

  if (!sessionId || !event) return false;
  if (!UUID_RE.test(sessionId)) return false;
  if (cwd && !isAbsolute(cwd)) return false;
  if (event !== "SessionStart") return false;

  const env = options.env ?? process.env;
  const paneId = env.TMUX_PANE ?? "";
  if (!paneId) return false;

  const rawTmux = await (options.displayMessage ?? displayTmuxWindowInfo)(paneId);
  const parsed = parseTmuxWindowInfo(rawTmux);
  if (!parsed) return false;

  const configDir =
    options.configDir ?? (await findConfigDirForTmuxSession(parsed.tmuxSessionName, env)) ?? agentConnectDir(env);
  const mapFile = join(configDir, "session_map.json");
  await mkdir(dirname(mapFile), { recursive: true });
  await withLock(`${mapFile.slice(0, mapFile.lastIndexOf("."))}.lock`, async () => {
    let sessionMap: JsonRecord = {};
    if (existsSync(mapFile)) {
      try {
        const existing = JSON.parse(await readFile(mapFile, "utf8")) as unknown;
        sessionMap = isRecord(existing) ? existing : {};
      } catch {
        sessionMap = {};
      }
    }

    const sessionWindowKey = `${parsed.tmuxSessionName}:${parsed.windowId}`;
    sessionMap[sessionWindowKey] = {
      session_id: sessionId,
      cwd,
      window_name: parsed.windowName
    };

    const oldKey = `${parsed.tmuxSessionName}:${parsed.windowName}`;
    if (oldKey !== sessionWindowKey && oldKey in sessionMap) {
      delete sessionMap[oldKey];
    }

    await atomicWriteJson(mapFile, sessionMap);
  });
  return true;
}

export function parseTmuxWindowInfo(raw: string): { tmuxSessionName: string; windowId: string; windowName: string } | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf(":");
  const second = first >= 0 ? trimmed.indexOf(":", first + 1) : -1;
  if (first < 0 || second < 0) return null;
  const tmuxSessionName = trimmed.slice(0, first);
  const windowId = trimmed.slice(first + 1, second);
  const windowName = trimmed.slice(second + 1);
  if (!tmuxSessionName || !windowId) return null;
  return {
    tmuxSessionName,
    windowId,
    windowName
  };
}

export async function hookMain(
  argv = process.argv.slice(2),
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr
): Promise<number> {
  const args = argv[0] === "hook" ? argv.slice(1) : argv;
  if (args.includes("--install")) {
    const result = await installAllHooks();
    (result.code === 0 ? stdout : stderr).write(`${result.message}\n`);
    return result.code;
  }

  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk;
  }
  if (!raw.trim()) return 0;

  try {
    const payload = JSON.parse(raw) as HookPayload;
    await processHookEvent(payload);
  } catch {
    return 0;
  }
  return 0;
}

async function displayTmuxWindowInfo(paneId: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", [
    "display-message",
    "-t",
    paneId,
    "-p",
    "#{session_name}:#{window_id}:#{window_name}"
  ], { encoding: "utf8" });
  return stdout.trim();
}

async function findAgcPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const binName of AGENT_CONNECT_BIN_NAMES) {
    for (const dir of pathDirs) {
      const candidate = join(dir, binName);
      try {
        await access(candidate, constants.X_OK);
        return shellQuote(candidate);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function isAgentConnectHookCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/\b(?:AGENT_CONNECT_HOOK|CCBOT_HOOK)=1\b/.test(trimmed)) return true;
  if (/(?:^|\s)(?:['"]?[^'"\s]*[\\/])?(?:agc|ccbot|ccbot-ts)(?:['"])?\s+hook(?:\s|$)/.test(trimmed)) return true;
  if (/pnpm\s+exec\s+tsx\s+src\/(?:(?:agent-connect|ccbot)\/main|index)\.ts\s+hook(?:\s|$)/.test(trimmed)) return true;
  for (const suffix of HOOK_COMMAND_SUFFIXES) {
    if (trimmed === suffix || trimmed.endsWith(`/${suffix}`)) return true;
  }
  return /(?:^|\s)(?:'|")?[^'"\s]*(?:[\\/](?:agent-connect|ccbot)[\\/]main|[\\/]packages[\\/]cli[\\/]dist[\\/]src[\\/]index)\.(?:js|ts)(?:'|")?\s+hook$/.test(trimmed);
}

function syncHookSettings(
  settings: JsonRecord,
  hookCommand: string,
  options: { matcher?: string } = {}
): boolean {
  const before = JSON.stringify(settings);
  const hookConfig = { type: "command", command: hookCommand, timeout: 5 };

  if (!isRecord(settings.hooks)) settings.hooks = {};
  const hooks = settings.hooks as JsonRecord;
  const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const sessionStart: unknown[] = [];
  let hasAgentConnectHook = false;

  for (const entry of existingSessionStart) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      sessionStart.push(entry);
      continue;
    }

    const existingHooks = entry.hooks;
    const nextHooks: unknown[] = [];
    let sawAgentConnectHookInEntry = false;
    let keptAgentConnectHookInEntry = false;

    for (const hook of existingHooks) {
      if (isRecord(hook) && typeof hook.command === "string" && isAgentConnectHookCommand(hook.command)) {
        sawAgentConnectHookInEntry = true;
        if (!hasAgentConnectHook) {
          nextHooks.push(hookConfig);
          hasAgentConnectHook = true;
          keptAgentConnectHookInEntry = true;
        }
        continue;
      }
      nextHooks.push(hook);
    }

    if (nextHooks.length === 0 && sawAgentConnectHookInEntry) continue;
    const nextEntry: JsonRecord = {
      ...entry,
      hooks: nextHooks
    };
    if (keptAgentConnectHookInEntry && options.matcher) {
      nextEntry.matcher = options.matcher;
    }
    sessionStart.push(nextEntry);
  }

  if (!hasAgentConnectHook) {
    const entry: JsonRecord = { hooks: [hookConfig] };
    if (options.matcher) entry.matcher = options.matcher;
    sessionStart.push(entry);
  }
  hooks.SessionStart = sessionStart;

  return JSON.stringify(settings) !== before;
}

function syncCodexHooksFeatureFlag(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let featuresStart = -1;
  let featuresEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(lines[index] ?? "");
    if (!section) continue;
    if (section[1] === "features") {
      featuresStart = index;
      featuresEnd = lines.length;
      continue;
    }
    if (featuresStart >= 0 && index > featuresStart) {
      featuresEnd = index;
      break;
    }
  }

  if (featuresStart < 0) {
    const prefix = lines.length > 0 ? [...lines, ""] : [];
    return [...prefix, "[features]", "hooks = true", ""].join("\n");
  }

  let hooksLine = -1;
  for (let index = featuresStart + 1; index < featuresEnd; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*hooks\s*=/.test(line)) hooksLine = index;
  }

  for (let index = featuresEnd - 1; index > featuresStart; index -= 1) {
    if (/^\s*codex_hooks\s*=/.test(lines[index] ?? "")) {
      lines.splice(index, 1);
      if (hooksLine > index) hooksLine -= 1;
      featuresEnd -= 1;
    }
  }

  if (hooksLine >= 0) {
    lines[hooksLine] = "hooks = true";
    return `${lines.join("\n")}\n`;
  }

  lines.splice(featuresEnd, 0, "hooks = true");
  return `${lines.join("\n")}\n`;
}

async function findConfigDirForTmuxSession(tmuxSessionName: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const { SqliteConfigStore } = await import("./configStore.js");
  let store: InstanceType<typeof SqliteConfigStore> | null = null;
  try {
    const baseDir = agentConnectDir(env);
    store = new SqliteConfigStore(env.AGENT_CONNECT_DB_FILE);
    const record = store.findBotByTmuxSessionName(tmuxSessionName);
    return record ? botConfigDir(baseDir, record.id) : null;
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function withLock<T>(lockFile: string, fn: () => Promise<T>, retries = 50): Promise<T> {
  await mkdir(dirname(lockFile), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      handle = await open(lockFile, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      break;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST" || attempt === retries - 1) throw error;
      await sleep(20);
    }
  }

  if (!handle) throw new Error(`Failed to acquire lock: ${lockFile}`);
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockFile, { force: true });
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
