import { existsSync } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { TranscriptParser } from "./transcriptParser.js";

export interface CodexSessionRecord {
  sessionId: string;
  summary: string;
  messageCount: number;
  filePath: string;
  cwd: string;
  updatedAtMs: number;
}

interface CodexSessionInfo {
  sessionId: string;
  filePath: string;
  cwd: string;
  updatedAtMs: number;
}

interface CodexIndexEntry {
  summary: string;
  updatedAtMs: number;
}

const DEFAULT_SCAN_LIMIT = 500;

export async function listCodexSessionsForDirectory(
  codexHomePath: string,
  cwd: string,
  limit = 10
): Promise<CodexSessionRecord[]> {
  const targetCwd = await normalizePath(cwd);
  const index = await readCodexSessionIndex(codexHomePath);
  const files = await listCodexJsonlFiles(codexHomePath, DEFAULT_SCAN_LIMIT);
  const sessions: CodexSessionRecord[] = [];

  for (const filePath of files) {
    const meta = await readCodexSessionMeta(filePath);
    if (!meta) continue;
    if ((await normalizePath(meta.cwd)) !== targetCwd) continue;

    const session = await readCodexSessionRecord(filePath, index);
    if (session && session.messageCount > 0) sessions.push(session);
    if (sessions.length >= limit) break;
  }

  return sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export async function findCodexSession(
  codexHomePath: string,
  sessionId: string
): Promise<CodexSessionRecord | null> {
  const sessionInfo = await findCodexSessionInfo(codexHomePath, sessionId);
  if (!sessionInfo) return null;
  const index = await readCodexSessionIndex(codexHomePath);
  return readCodexSessionRecord(sessionInfo.filePath, index);
}

async function findCodexSessionInfo(
  codexHomePath: string,
  sessionId: string
): Promise<CodexSessionInfo | null> {
  if (!sessionId) return null;
  const files = await listCodexJsonlFiles(codexHomePath, Number.POSITIVE_INFINITY);
  for (const filePath of files) {
    const meta = await readCodexSessionMeta(filePath);
    if (meta?.sessionId !== sessionId) continue;
    const fileStat = await safeStat(filePath);
    return {
      sessionId: meta.sessionId,
      filePath,
      cwd: await normalizePath(meta.cwd),
      updatedAtMs: fileStat?.mtimeMs ?? 0
    };
  }
  return null;
}

async function readCodexSessionRecord(
  filePath: string,
  index: Map<string, CodexIndexEntry>
): Promise<CodexSessionRecord | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let sessionId = "";
  let cwd = "";
  let lastUserMessage = "";
  let messageCount = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const data = TranscriptParser.parseLine(rawLine);
    if (!data) continue;

    if (data.type === "session_meta" && isRecord(data.payload)) {
      sessionId = typeof data.payload.id === "string" ? data.payload.id : sessionId;
      cwd = typeof data.payload.cwd === "string" ? data.payload.cwd : cwd;
      continue;
    }

    if (data.type !== "response_item" || !isRecord(data.payload)) continue;
    if (data.payload.type !== "message") continue;
    const role = data.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    messageCount += 1;
    if (role === "user") {
      const text = extractCodexMessageText(data.payload.content);
      if (text.trim()) lastUserMessage = text.trim();
    }
  }

  if (!sessionId || !cwd) return null;
  const fileStat = await safeStat(filePath);
  const indexed = index.get(sessionId);
  const summary = indexed?.summary || (lastUserMessage ? lastUserMessage.slice(0, 50) : "Untitled");

  return {
    sessionId,
    summary,
    messageCount,
    filePath,
    cwd,
    updatedAtMs: indexed?.updatedAtMs ?? fileStat?.mtimeMs ?? 0
  };
}

async function readCodexSessionMeta(
  filePath: string
): Promise<{ sessionId: string; cwd: string } | null> {
  const firstLine = await readFirstNonEmptyLine(filePath);
  if (!firstLine) return null;
  const data = TranscriptParser.parseLine(firstLine);
  if (!data || data.type !== "session_meta" || !isRecord(data.payload)) return null;
  const sessionId = typeof data.payload.id === "string" ? data.payload.id : "";
  const cwd = typeof data.payload.cwd === "string" ? data.payload.cwd : "";
  return sessionId && cwd ? { sessionId, cwd } : null;
}

async function readCodexSessionIndex(codexHomePath: string): Promise<Map<string, CodexIndexEntry>> {
  const indexFile = join(codexHomePath, "session_index.jsonl");
  const result = new Map<string, CodexIndexEntry>();
  if (!existsSync(indexFile)) return result;

  let content = "";
  try {
    content = await readFile(indexFile, "utf8");
  } catch {
    return result;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const data = TranscriptParser.parseLine(rawLine);
    if (!data) continue;
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) continue;
    const summary = typeof data.thread_name === "string" ? data.thread_name : "";
    const updatedAt = typeof data.updated_at === "string" ? Date.parse(data.updated_at) : Number.NaN;
    result.set(id, {
      summary,
      updatedAtMs: Number.isFinite(updatedAt) ? updatedAt : 0
    });
  }
  return result;
}

async function listCodexJsonlFiles(codexHomePath: string, limit: number): Promise<string[]> {
  const sessionsDir = join(codexHomePath, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files = await walkJsonlFiles(sessionsDir);
  const withStats: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const filePath of files) {
    const fileStat = await safeStat(filePath);
    if (fileStat) withStats.push({ filePath, mtimeMs: fileStat.mtimeMs });
  }
  return withStats
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonlFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

async function readFirstNonEmptyLine(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    let total = 0;
    const maxBytes = 1024 * 1024;

    while (total < maxBytes) {
      const buffer = Buffer.alloc(Math.min(8192, maxBytes - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }

      chunks.push(chunk);
      position += bytesRead;
      total += bytesRead;
    }

    return Buffer.concat(chunks).toString("utf8").trim();
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

function extractCodexMessageText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      if (typeof item === "string" && item) parts.push(item);
      continue;
    }
    const text = typeof item.text === "string" ? item.text : "";
    if (text && (item.type === "input_text" || item.type === "output_text" || item.type === "text")) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

async function normalizePath(path: string): Promise<string> {
  if (!path) return "";
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
