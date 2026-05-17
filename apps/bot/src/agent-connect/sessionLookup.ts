import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findCodexSession, listCodexSessionsForDirectory } from "./codexSessions.js";
import type { AgentType } from "./hookTypes.js";
import { TranscriptParser } from "./transcriptParser.js";
import type { SessionRegistry } from "./sessionRegistry.js";

export interface SessionSummary {
  sessionId: string;
  summary: string;
  messageCount: number;
  filePath: string;
  agentType?: AgentType;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  contentType: string;
  timestamp: string | null;
}

export interface LookupConfig {
  claudeProjectsPath: string;
  codexHomePath: string;
  agentType: AgentType;
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function buildSessionFilePath(
  config: Pick<LookupConfig, "claudeProjectsPath">,
  sessionId: string,
  cwd: string
): string | null {
  if (!sessionId || !cwd) return null;
  return join(config.claudeProjectsPath, encodeCwd(cwd), `${sessionId}.jsonl`);
}

async function findSessionFileByGlob(
  config: Pick<LookupConfig, "claudeProjectsPath">,
  sessionId: string
): Promise<string | null> {
  if (!existsSync(config.claudeProjectsPath)) return null;
  const dirs = await readdir(config.claudeProjectsPath, { withFileTypes: true });
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const candidate = join(config.claudeProjectsPath, dirent.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function getSessionDirect(
  config: LookupConfig,
  sessionId: string,
  cwd: string,
  agentType: AgentType = config.agentType
): Promise<SessionSummary | null> {
  if (agentType === "codex") {
    const session = await findCodexSession(config.codexHomePath, sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      summary: session.summary,
      messageCount: session.messageCount,
      filePath: session.filePath,
      agentType: "codex"
    };
  }

  let filePath = buildSessionFilePath(config, sessionId, cwd);
  if (!filePath || !existsSync(filePath)) {
    filePath = await findSessionFileByGlob(config, sessionId);
    if (!filePath) return null;
  }

  let summary = "";
  let lastUserMsg = "";
  let messageCount = 0;

  try {
    const content = await readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      messageCount += 1;
      const data = TranscriptParser.parseLine(line);
      if (!data) continue;
      if (data.type === "summary" && typeof data.summary === "string" && data.summary) {
        summary = data.summary;
      } else if (TranscriptParser.isUserMessage(data)) {
        const parsed = TranscriptParser.parseMessage(data);
        if (parsed?.text.trim()) lastUserMsg = parsed.text.trim();
      }
    }
  } catch {
    return null;
  }

  if (!summary) summary = lastUserMsg ? lastUserMsg.slice(0, 50) : "Untitled";
  return { sessionId, summary, messageCount, filePath, agentType: "claude" };
}

export async function listSessionsForDirectory(
  config: LookupConfig,
  cwd: string,
  agentType: AgentType = config.agentType
): Promise<SessionSummary[]> {
  if (agentType === "codex") {
    const sessions = await listCodexSessionsForDirectory(config.codexHomePath, cwd);
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      summary: session.summary,
      messageCount: session.messageCount,
      filePath: session.filePath,
      agentType: "codex"
    }));
  }

  const projectDir = join(config.claudeProjectsPath, encodeCwd(cwd));
  if (!existsSync(projectDir)) return [];

  const files = (await readdir(projectDir))
    .filter((name) => name.endsWith(".jsonl") && name !== "sessions-index.json")
    .map((name) => join(projectDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, 10);

  const sessions: SessionSummary[] = [];
  for (const file of files) {
    const sessionId = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
    const session = await getSessionDirect(config, sessionId, cwd);
    if (session && session.messageCount > 0) sessions.push(session);
  }
  return sessions;
}

export async function getRecentMessages(
  config: LookupConfig,
  registry: Pick<SessionRegistry, "getSessionByWindow">,
  windowId: string,
  options: { startByte?: number; endByte?: number | null } = {}
): Promise<[HistoryMessage[], number]> {
  const row = registry.getSessionByWindow(windowId);
  if (!row) return [[], 0];

  const filePath = row.transcript_path;
  if (!filePath || !existsSync(filePath)) return [[], 0];

  const startByte = options.startByte ?? 0;
  const endByte = options.endByte ?? null;
  const buffer = await readFile(filePath);
  const end = endByte ?? buffer.length;
  const text = buffer.subarray(startByte, end).toString("utf8");
  const entries = text
    .split(/\r?\n/)
    .map((line) => TranscriptParser.parseLine(line))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const [parsedEntries] = TranscriptParser.parseEntries(entries);
  const messages = parsedEntries.map((entry) => ({
    role: entry.role,
    text: entry.text,
    contentType: entry.contentType,
    timestamp: entry.timestamp ?? null
  }));

  return [messages, messages.length];
}
