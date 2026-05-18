import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, delimiter, join } from "node:path";

export const HOOK_COMMAND_SUFFIX = "agc hook";
export const HOOK_COMMAND_SUFFIXES = [HOOK_COMMAND_SUFFIX, "ccbot hook", "ccbot-ts hook"] as const;
const AGENT_CONNECT_BIN_NAMES = ["agc"] as const;

const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "Stop",
  "Notification"
  // PermissionRequest deliberately omitted: Claude's TUI shows a clickable
  // prompt (handled by StatusPoller + interactiveUi via tmux pane matching),
  // which is richer than a plain status text and gives the user inline
  // keyboard buttons. Adding the hook would duplicate that with a less
  // useful text-only message. Codex still installs it (no TUI matcher).
] as const;

const CLAUDE_SESSION_START_MATCHER = "startup|resume|clear|compact";

const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop"
  // PermissionRequest deliberately omitted (since terminalParser.UI_PATTERNS
  // started matching 'Would you like to run the following command?' and
  // 'Would you like to make the following edits?'). The TUI-driven path
  // surfaces a Telegram message WITH inline keyboard buttons (↑↓ Enter Esc)
  // that are translated to tmux send-keys — much more actionable than a
  // plain-text 'Approval needed: ...' status. The HookRouter handler stays
  // in place as defense-in-depth in case the install list ever changes.
] as const;

const CODEX_SESSION_START_MATCHER = "startup|resume|clear";

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

  let changed = syncHookSettings(settings, hookCommand, {
    events: [...CLAUDE_HOOK_EVENTS]
  });
  changed = syncHookSettings(settings, hookCommand, {
    events: ["SessionStart"],
    matcher: CLAUDE_SESSION_START_MATCHER
  }) || changed;

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

  let hooksChanged = syncHookSettings(settings, hookCommand, {
    events: [...CODEX_HOOK_EVENTS]
  });
  hooksChanged = syncHookSettings(settings, hookCommand, {
    events: ["SessionStart"],
    matcher: CODEX_SESSION_START_MATCHER
  }) || hooksChanged;

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

  let command = HOOK_COMMAND_SUFFIX;
  const currentEntrypoint = options.entrypoint ?? process.argv[1];
  if (currentEntrypoint) {
    const name = basename(currentEntrypoint);
    if ((AGENT_CONNECT_BIN_NAMES as readonly string[]).includes(name)) {
      return withHookEnv(command, env);
    }
    if (name === "main.js" || name === "index.js") {
      if (await findAgcPath(env)) return withHookEnv(command, env);
      command = `${shellQuote(process.execPath)} ${shellQuote(currentEntrypoint)} hook`;
      return withHookEnv(command, env);
    }
    if (name === "main.ts") {
      if (await findAgcPath(env)) return withHookEnv(command, env);
      const appDir = dirname(dirname(dirname(currentEntrypoint)));
      command = `cd ${shellQuote(appDir)} && pnpm exec tsx src/agent-connect/main.ts hook`;
      return withHookEnv(command, env);
    }
    if (name === "index.ts") {
      if (await findAgcPath(env)) return withHookEnv(command, env);
      const packageDir = dirname(dirname(currentEntrypoint));
      command = `cd ${shellQuote(packageDir)} && pnpm exec tsx src/index.ts hook`;
      return withHookEnv(command, env);
    }
  }

  return withHookEnv(command, env);
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

export function isAgentConnectHookCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/\b(?:AGENT_CONNECT_HOOK|CCBOT_HOOK)=1\b/.test(trimmed)) return true;
  if (/(?:^|\s)(?:['"]?[^'"\s]*[\\/])?(?:agc|ccbot|ccbot-ts)(?:['"])?\s+hook(?:\s|$)/.test(trimmed)) return true;
  if (/pnpm\s+exec\s+tsx\s+src\/(?:(?:agent-connect|ccbot)\/main|index)\.ts\s+hook(?:\s|$)/.test(trimmed)) return true;
  for (const suffix of HOOK_COMMAND_SUFFIXES) {
    if (trimmed === suffix || trimmed.endsWith(`/${suffix}`)) return true;
  }
  return /(?:^|\s)(?:'|")?[^'"\s]*(?:[\\/](?:agent-connect|ccbot)[\\/]main|[\\/]packages[\\/]cli[\\/]dist[\\/]src[\\/]index)\.(?:js|ts)(?:'|")?\s+hook$/.test(trimmed);
}

export function syncHookSettings(
  settings: JsonRecord,
  hookCommand: string,
  options: { events?: string[]; matcher?: string } = {}
): boolean {
  const events = options.events && options.events.length > 0 ? options.events : ["SessionStart"];
  let anyChanged = false;
  for (const event of events) {
    if (syncSingleEvent(settings, event, hookCommand, options.matcher)) {
      anyChanged = true;
    }
  }
  return anyChanged;
}

function syncSingleEvent(
  settings: JsonRecord,
  eventName: string,
  hookCommand: string,
  matcher?: string
): boolean {
  const before = JSON.stringify(settings);
  const hookConfig = { type: "command", command: hookCommand, timeout: 5 };

  if (!isRecord(settings.hooks)) settings.hooks = {};
  const hooks = settings.hooks as JsonRecord;
  const existing = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
  const nextEntries: unknown[] = [];
  let hasAgentConnectHook = false;

  for (const entry of existing) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
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
    if (keptAgentConnectHookInEntry && matcher) {
      nextEntry.matcher = matcher;
    }
    nextEntries.push(nextEntry);
  }

  if (!hasAgentConnectHook) {
    const entry: JsonRecord = { hooks: [hookConfig] };
    if (matcher) entry.matcher = matcher;
    nextEntries.push(entry);
  }
  hooks[eventName] = nextEntries;

  return JSON.stringify(settings) !== before;
}

export function syncCodexHooksFeatureFlag(content: string): string {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function withHookEnv(command: string, env: NodeJS.ProcessEnv): string {
  const assignments = ["AGENT_CONNECT_DIR", "AGENT_CONNECT_DB_FILE"].flatMap((name) => {
    const value = env[name]?.trim();
    return value ? [`${name}=${shellQuote(value)}`] : [];
  });
  return assignments.length > 0 ? `${assignments.join(" ")} ${command}` : command;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
