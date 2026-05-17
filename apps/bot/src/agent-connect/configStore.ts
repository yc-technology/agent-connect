import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfigDbPath, type BotConfigInput, type BotConfigPatch, type BotConfigRecord } from "./botConfig.js";
import {
  DEFAULT_AGENT_TYPE,
  DEFAULT_CLAUDE_COMMAND,
  defaultCommandForAgent,
  normalizeAgentType,
  type AgentType
} from "./claudeCommand.js";

interface BotConfigRow {
  id: string;
  name: string;
  telegram_bot_token: string;
  allowed_users: string;
  agent_type?: string;
  tmux_session_name: string;
  claude_command: string;
  openai_api_key: string;
  openai_base_url: string;
  monitor_poll_interval: number;
  show_user_messages: number;
  show_tool_calls: number;
  show_hidden_dirs: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class SqliteConfigStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(dbPath = defaultConfigDbPath()) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  listBots(): BotConfigRecord[] {
    return this.db
      .prepare("SELECT * FROM bot_configs ORDER BY created_at ASC")
      .all()
      .map((row) => rowToBotConfig(row as unknown as BotConfigRow));
  }

  listEnabledBots(): BotConfigRecord[] {
    return this.db
      .prepare("SELECT * FROM bot_configs WHERE enabled = 1 ORDER BY created_at ASC")
      .all()
      .map((row) => rowToBotConfig(row as unknown as BotConfigRow));
  }

  getBot(id: string): BotConfigRecord | null {
    const row = this.db.prepare("SELECT * FROM bot_configs WHERE id = ?").get(id);
    return row ? rowToBotConfig(row as unknown as BotConfigRow) : null;
  }

  findBotByTmuxSessionName(tmuxSessionName: string): BotConfigRecord | null {
    const row = this.db
      .prepare("SELECT * FROM bot_configs WHERE tmux_session_name = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 1")
      .get(tmuxSessionName);
    return row ? rowToBotConfig(row as unknown as BotConfigRow) : null;
  }

  createBot(input: BotConfigInput): BotConfigRecord {
    const now = new Date().toISOString();
    const id = normalizeId(input.id ?? input.name);
    const record = normalizeInput(input, id, now, now);
    this.db
      .prepare(
        `INSERT INTO bot_configs (
          id, name, telegram_bot_token, allowed_users, agent_type, tmux_session_name,
          claude_command, openai_api_key, openai_base_url, monitor_poll_interval,
          show_user_messages, show_tool_calls, show_hidden_dirs, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.name,
        record.telegramBotToken,
        JSON.stringify(record.allowedUsers),
        record.agentType,
        record.tmuxSessionName,
        record.claudeCommand,
        record.openaiApiKey,
        record.openaiBaseUrl,
        record.monitorPollInterval,
        boolToInt(record.showUserMessages),
        boolToInt(record.showToolCalls),
        boolToInt(record.showHiddenDirs),
        boolToInt(record.enabled),
        record.createdAt,
        record.updatedAt
      );
    return record;
  }

  updateBot(id: string, patch: BotConfigPatch): BotConfigRecord | null {
    const current = this.getBot(id);
    if (!current) return null;

    const updated: BotConfigRecord = {
      ...current,
      ...normalizePatch(current, patch),
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `UPDATE bot_configs SET
          name = ?, telegram_bot_token = ?, allowed_users = ?, agent_type = ?, tmux_session_name = ?,
          claude_command = ?, openai_api_key = ?, openai_base_url = ?, monitor_poll_interval = ?,
          show_user_messages = ?, show_tool_calls = ?, show_hidden_dirs = ?, enabled = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        updated.name,
        updated.telegramBotToken,
        JSON.stringify(updated.allowedUsers),
        updated.agentType,
        updated.tmuxSessionName,
        updated.claudeCommand,
        updated.openaiApiKey,
        updated.openaiBaseUrl,
        updated.monitorPollInterval,
        boolToInt(updated.showUserMessages),
        boolToInt(updated.showToolCalls),
        boolToInt(updated.showHiddenDirs),
        boolToInt(updated.enabled),
        updated.updatedAt,
        id
      );
    return updated;
  }

  deleteBot(id: string): boolean {
    const result = this.db.prepare("DELETE FROM bot_configs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  ensureDefaultBotFromEnv(env: NodeJS.ProcessEnv = process.env): BotConfigRecord | null {
    if (!env.TELEGRAM_BOT_TOKEN || !env.ALLOWED_USERS) return null;
    const existing = this.getBot("default");
    if (existing) return existing;

    return this.createBot({
      id: "default",
      name: "Default Bot",
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      allowedUsers: parseAllowedUsersList(env.ALLOWED_USERS),
      agentType: normalizeAgentType(env.AGENT_CONNECT_AGENT_TYPE),
      tmuxSessionName: env.TMUX_SESSION_NAME ?? "agent-connect",
      claudeCommand: env.CLAUDE_COMMAND ?? env.CODEX_COMMAND ?? defaultCommandForAgent(normalizeAgentType(env.AGENT_CONNECT_AGENT_TYPE)),
      openaiApiKey: env.OPENAI_API_KEY ?? "",
      openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      monitorPollInterval: Number.parseFloat(env.MONITOR_POLL_INTERVAL ?? "2.0"),
      showUserMessages: (env.AGENT_CONNECT_SHOW_USER_MESSAGES ?? "false").toLowerCase() === "true",
      showToolCalls: parseBooleanEnv(env.AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES ?? env.AGENT_CONNECT_SHOW_TOOL_CALLS, false),
      showHiddenDirs: (env.AGENT_CONNECT_SHOW_HIDDEN_DIRS ?? "").toLowerCase() === "true",
      enabled: true
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        telegram_bot_token TEXT NOT NULL,
        allowed_users TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'claude',
        tmux_session_name TEXT NOT NULL,
        claude_command TEXT NOT NULL,
        openai_api_key TEXT NOT NULL DEFAULT '',
        openai_base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
        monitor_poll_interval REAL NOT NULL DEFAULT 2.0,
        show_user_messages INTEGER NOT NULL DEFAULT 0,
        show_tool_calls INTEGER NOT NULL DEFAULT 0,
        show_hidden_dirs INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bot_configs_tmux_session
        ON bot_configs(tmux_session_name);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("bot_configs", "agent_type", "TEXT NOT NULL DEFAULT 'claude'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function rowToBotConfig(row: BotConfigRow): BotConfigRecord {
  return {
    id: row.id,
    name: row.name,
    telegramBotToken: row.telegram_bot_token,
    allowedUsers: parseAllowedUsersJson(row.allowed_users),
    agentType: normalizeAgentType(row.agent_type ?? DEFAULT_AGENT_TYPE),
    tmuxSessionName: row.tmux_session_name,
    claudeCommand: row.claude_command,
    openaiApiKey: row.openai_api_key,
    openaiBaseUrl: row.openai_base_url,
    monitorPollInterval: row.monitor_poll_interval,
    showUserMessages: row.show_user_messages === 1,
    showToolCalls: row.show_tool_calls === 1,
    showHiddenDirs: row.show_hidden_dirs === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeInput(input: BotConfigInput, id: string, createdAt: string, updatedAt: string): BotConfigRecord {
  if (!input.telegramBotToken.trim()) throw new Error("telegramBotToken is required");
  if (input.allowedUsers.length === 0) throw new Error("allowedUsers is required");
  const agentType = normalizeAgentType(input.agentType ?? DEFAULT_AGENT_TYPE);
  return {
    id,
    name: input.name.trim() || id,
    telegramBotToken: input.telegramBotToken.trim(),
    allowedUsers: [...new Set(input.allowedUsers)].filter(Number.isSafeInteger),
    agentType,
    tmuxSessionName: input.tmuxSessionName?.trim() || `agent-connect-${id}`,
    claudeCommand: input.claudeCommand?.trim() || defaultCommandForAgent(agentType),
    openaiApiKey: input.openaiApiKey?.trim() ?? "",
    openaiBaseUrl: input.openaiBaseUrl?.trim() || "https://api.openai.com/v1",
    monitorPollInterval: input.monitorPollInterval ?? 2.0,
    showUserMessages: input.showUserMessages ?? false,
    showToolCalls: input.showToolCalls ?? false,
    showHiddenDirs: input.showHiddenDirs ?? false,
    enabled: input.enabled ?? true,
    createdAt,
    updatedAt
  };
}

function definedPatch(patch: BotConfigPatch): Partial<BotConfigRecord> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<BotConfigRecord>;
}

function normalizePatch(current: BotConfigRecord, patch: BotConfigPatch): Partial<BotConfigRecord> {
  const next = definedPatch(patch);
  if (patch.agentType !== undefined) {
    const agentType = normalizeAgentType(patch.agentType);
    next.agentType = agentType;
    if (patch.claudeCommand === undefined && isDefaultCommandForAgent(current.claudeCommand, current.agentType)) {
      next.claudeCommand = defaultCommandForAgent(agentType);
    }
  }
  return next;
}

function isDefaultCommandForAgent(command: string, agentType: AgentType): boolean {
  return command.trim() === defaultCommandForAgent(agentType);
}

function parseAllowedUsersJson(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

function parseAllowedUsersList(raw: string): number[] {
  return raw
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter(Number.isSafeInteger);
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || randomUUID();
}

function boolToInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
