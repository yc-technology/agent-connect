import { join } from "node:path";
import type { AgentType } from "./claudeCommand.js";
import { agentConnectDir } from "./utils.js";

export interface BotConfigRecord {
  id: string;
  name: string;
  telegramBotToken: string;
  allowedUsers: number[];
  agentType: AgentType;
  tmuxSessionName: string;
  claudeCommand: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  monitorPollInterval: number;
  showUserMessages: boolean;
  showToolCalls: boolean;
  showHiddenDirs: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BotConfigInput {
  id?: string;
  name: string;
  telegramBotToken: string;
  allowedUsers: number[];
  agentType?: AgentType;
  tmuxSessionName?: string;
  claudeCommand?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  monitorPollInterval?: number;
  showUserMessages?: boolean;
  showToolCalls?: boolean;
  showHiddenDirs?: boolean;
  enabled?: boolean;
}

export interface BotConfigPatch {
  name?: string;
  telegramBotToken?: string;
  allowedUsers?: number[];
  agentType?: AgentType;
  tmuxSessionName?: string;
  claudeCommand?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  monitorPollInterval?: number;
  showUserMessages?: boolean;
  showToolCalls?: boolean;
  showHiddenDirs?: boolean;
  enabled?: boolean;
}

export interface PublicBotConfig {
  id: string;
  name: string;
  telegramBotTokenSet: boolean;
  allowedUsers: number[];
  agentType: AgentType;
  tmuxSessionName: string;
  claudeCommand: string;
  openaiApiKeySet: boolean;
  openaiBaseUrl: string;
  monitorPollInterval: number;
  showUserMessages: boolean;
  showToolCalls: boolean;
  showHiddenDirs: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function defaultConfigDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentConnectDir(env), "agent-connect.sqlite");
}

export function botConfigDir(baseConfigDir: string, botId: string): string {
  return join(baseConfigDir, "bots", botId);
}

export function toPublicBotConfig(record: BotConfigRecord): PublicBotConfig {
  return {
    id: record.id,
    name: record.name,
    telegramBotTokenSet: record.telegramBotToken.length > 0,
    allowedUsers: record.allowedUsers,
    agentType: record.agentType,
    tmuxSessionName: record.tmuxSessionName,
    claudeCommand: record.claudeCommand,
    openaiApiKeySet: record.openaiApiKey.length > 0,
    openaiBaseUrl: record.openaiBaseUrl,
    monitorPollInterval: record.monitorPollInterval,
    showUserMessages: record.showUserMessages,
    showToolCalls: record.showToolCalls,
    showHiddenDirs: record.showHiddenDirs,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
