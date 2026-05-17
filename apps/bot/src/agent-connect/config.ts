import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { BotConfigRecord } from "./botConfig.js";
import { botConfigDir, defaultConfigDbPath } from "./botConfig.js";
import {
  DEFAULT_AGENT_TYPE,
  defaultCommandForAgent,
  normalizeAgentType,
  type AgentType
} from "./claudeCommand.js";
import { agentConnectDir } from "./utils.js";

export const SENSITIVE_ENV_VARS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_USERS",
  "OPENAI_API_KEY"
]);

export class Config {
  readonly configDir: string;
  readonly telegramBotToken: string;
  readonly allowedUsers: Set<number>;
  readonly tmuxSessionName: string;
  readonly tmuxMainWindowName = "__main__";
  readonly agentType: AgentType;
  readonly claudeCommand: string;
  readonly stateFile: string;
  readonly sessionMapFile: string;
  readonly monitorStateFile: string;
  readonly claudeProjectsPath: string;
  readonly codexHomePath: string;
  readonly monitorPollInterval: number;
  readonly showUserMessages: boolean;
  readonly showToolCalls: boolean;
  readonly showHiddenDirs: boolean;
  readonly openaiApiKey: string;
  readonly openaiBaseUrl: string;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly enableTelegram: boolean;
  readonly enableMonitor: boolean;
  readonly topicProbeInterval: number;
  readonly databaseFile: string;
  readonly botId: string | null;

  constructor(env: NodeJS.ProcessEnv = process.env, options: ConfigOptions = {}) {
    this.botId = options.bot?.id ?? null;

    const baseConfigDir = loadRuntimeEnv(env);
    this.configDir = options.configDir ?? (options.bot ? botConfigDir(baseConfigDir, options.bot.id) : baseConfigDir);
    mkdirSync(this.configDir, { recursive: true });

    this.telegramBotToken = options.bot?.telegramBotToken ?? env.TELEGRAM_BOT_TOKEN ?? "";
    if (!this.telegramBotToken && options.requireTelegramConfig !== false) {
      throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
    }

    const allowedUsersRaw = env.ALLOWED_USERS ?? "";
    if (options.bot) {
      this.allowedUsers = new Set(options.bot.allowedUsers);
    } else if (!allowedUsersRaw && options.requireTelegramConfig !== false) {
      throw new Error("ALLOWED_USERS environment variable is required");
    } else {
      this.allowedUsers = allowedUsersRaw ? parseAllowedUsers(allowedUsersRaw) : new Set();
    }

    this.tmuxSessionName = options.bot?.tmuxSessionName ?? env.TMUX_SESSION_NAME ?? "agent-connect";
    this.agentType = options.bot?.agentType ?? normalizeAgentType(env.AGENT_CONNECT_AGENT_TYPE ?? DEFAULT_AGENT_TYPE);
    this.claudeCommand =
      options.bot?.claudeCommand ??
      env.CLAUDE_COMMAND ??
      env.CODEX_COMMAND ??
      defaultCommandForAgent(this.agentType);

    this.stateFile = join(this.configDir, "state.json");
    this.sessionMapFile = join(this.configDir, "session_map.json");
    this.monitorStateFile = join(this.configDir, "monitor_state.json");
    this.databaseFile = env.AGENT_CONNECT_DB_FILE ?? defaultConfigDbPath(env);

    if (env.AGENT_CONNECT_CLAUDE_PROJECTS_PATH) {
      this.claudeProjectsPath = env.AGENT_CONNECT_CLAUDE_PROJECTS_PATH;
    } else if (env.CLAUDE_CONFIG_DIR) {
      this.claudeProjectsPath = join(env.CLAUDE_CONFIG_DIR, "projects");
    } else {
      this.claudeProjectsPath = join(homedir(), ".claude", "projects");
    }
    this.codexHomePath = env.AGENT_CONNECT_CODEX_HOME ?? env.CODEX_HOME ?? join(homedir(), ".codex");

    this.monitorPollInterval = options.bot?.monitorPollInterval ?? Number.parseFloat(env.MONITOR_POLL_INTERVAL ?? "2.0");
    this.showUserMessages =
      options.bot?.showUserMessages ?? ((env.AGENT_CONNECT_SHOW_USER_MESSAGES ?? "false").toLowerCase() === "true");
    this.showToolCalls =
      options.bot?.showToolCalls ??
      parseBooleanEnv(env.AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES ?? env.AGENT_CONNECT_SHOW_TOOL_CALLS, false);
    this.showHiddenDirs =
      options.bot?.showHiddenDirs ?? ((env.AGENT_CONNECT_SHOW_HIDDEN_DIRS ?? "").toLowerCase() === "true");
    this.openaiApiKey = options.bot?.openaiApiKey ?? env.OPENAI_API_KEY ?? "";
    this.openaiBaseUrl = options.bot?.openaiBaseUrl ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.httpHost = env.AGENT_CONNECT_HTTP_HOST ?? "127.0.0.1";
    this.httpPort = Number.parseInt(env.AGENT_CONNECT_HTTP_PORT ?? "8787", 10);
    this.enableTelegram = (env.AGENT_CONNECT_TS_ENABLE_TELEGRAM ?? "true").toLowerCase() !== "false";
    this.enableMonitor =
      this.enableTelegram || (env.AGENT_CONNECT_TS_ENABLE_MONITOR ?? "false").toLowerCase() === "true";
    this.topicProbeInterval = parseNonNegativeFloat(env.AGENT_CONNECT_TOPIC_PROBE_INTERVAL, 60.0);

    if (options.sanitizeProcessEnv !== false) {
      sanitizeSensitiveEnv();
    }
  }

  isUserAllowed(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export interface ConfigOptions {
  requireTelegramConfig?: boolean;
  configDir?: string;
  bot?: BotConfigRecord;
  sanitizeProcessEnv?: boolean;
}

export function sanitizeSensitiveEnv(): void {
  for (const varName of SENSITIVE_ENV_VARS) {
    delete process.env[varName];
  }
}

export function loadRuntimeEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  loadEnvFiles(workspaceEnvFiles(cwd), env);
  let baseConfigDir = agentConnectDir(env);
  loadEnvFiles([join(baseConfigDir, ".env")], env);
  return agentConnectDir(env);
}

function workspaceEnvFiles(cwd = process.cwd()): string[] {
  return uniqueExistingPaths([
    join(cwd, ".env"),
    join(cwd, "..", ".env"),
    join(cwd, "..", "..", ".env")
  ]);
}

function loadEnvFiles(paths: string[], env: NodeJS.ProcessEnv): void {
  for (const envFile of uniqueExistingPaths(paths)) {
    loadDotenv({ path: envFile, override: false, processEnv: env as Record<string, string> });
  }
}

function uniqueExistingPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = resolve(path);
    if (seen.has(normalized) || !existsSync(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseAllowedUsers(raw: string): Set<number> {
  const users = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(
        `ALLOWED_USERS contains non-numeric value: ${trimmed}. Expected comma-separated Telegram user IDs.`
      );
    }
    const value = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `ALLOWED_USERS contains non-numeric value: ${trimmed}. Expected comma-separated Telegram user IDs.`
      );
    }
    users.add(value);
  }
  if (users.size === 0) {
    throw new Error("ALLOWED_USERS environment variable is required");
  }
  return users;
}

function parseNonNegativeFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
