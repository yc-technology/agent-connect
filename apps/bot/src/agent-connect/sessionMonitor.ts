import { existsSync, type Dirent } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { findCodexSessionInfo, scanCodexSessionsForCwds, type CodexSessionInfo } from "./codexSessions.js";
import type { Config } from "./config.js";
import { MonitorState, TrackedSession } from "./monitorState.js";
import { TranscriptParser, type PendingToolInfo, type ToolResultImage } from "./transcriptParser.js";
import type { TmuxManager, TmuxWindow } from "./tmuxManager.js";
import { readCwdFromJsonl } from "./utils.js";

export interface SessionInfo {
  sessionId: string;
  filePath: string;
}

export interface NewMessage {
  sessionId: string;
  windowId?: string | null;
  text: string;
  isComplete: boolean;
  contentType: string;
  toolUseId?: string | null;
  role: "user" | "assistant";
  toolName?: string | null;
  imageData?: ToolResultImage[] | null;
}

export type MessageCallback = (msg: NewMessage) => Promise<void> | void;

export interface SessionMonitorOptions {
  projectsPath: string;
  stateFile: string;
  pollInterval?: number;
  config?: Pick<
    Config,
    "sessionMapFile" | "tmuxSessionName" | "showUserMessages" | "monitorPollInterval"
  > &
    Partial<Pick<Config, "agentType" | "codexHomePath" | "stateFile">>;
  tmuxManager?: Pick<TmuxManager, "listWindows">;
  boundWindowIds?: () => Iterable<string>;
}

export class SessionMonitor {
  readonly projectsPath: string;
  readonly pollInterval: number;
  readonly state: MonitorState;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;
  private sleepResolve: (() => void) | null = null;
  private messageCallback: MessageCallback | null = null;
  private readonly pendingTools: Record<string, Record<string, PendingToolInfo>> = {};
  private lastSessionMap: Record<string, string> = {};
  private readonly fileMtimes: Record<string, number> = {};

  constructor(private readonly options: SessionMonitorOptions) {
    this.projectsPath = options.projectsPath;
    this.pollInterval = options.pollInterval ?? options.config?.monitorPollInterval ?? 2.0;
    this.state = new MonitorState(options.stateFile);
    this.state.load();
  }

  setMessageCallback(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  async getActiveCwds(): Promise<Set<string>> {
    const cwds = new Set<string>();
    const windows = this.options.tmuxManager ? await this.options.tmuxManager.listWindows() : [];
    for (const window of windows as TmuxWindow[]) {
      cwds.add(await normalizePath(window.cwd));
    }
    return cwds;
  }

  async scanProjects(): Promise<SessionInfo[]> {
    const activeCwds = await this.getActiveCwds();
    if (activeCwds.size === 0 || !existsSync(this.projectsPath)) {
      if (this.options.config?.agentType === "codex" && activeCwds.size > 0) {
        return this.scanCodexProjects(activeCwds);
      }
      return [];
    }

    if (this.options.config?.agentType === "codex") {
      return this.scanCodexProjects(activeCwds);
    }

    const sessions: SessionInfo[] = [];
    const projectEntries = await safeReaddir(this.projectsPath);

    for (const dirent of projectEntries) {
      if (!dirent.isDirectory()) continue;
      const projectDir = join(this.projectsPath, dirent.name);
      const indexFile = join(projectDir, "sessions-index.json");
      let originalPath = "";
      const indexedIds = new Set<string>();

      if (existsSync(indexFile)) {
        try {
          const indexData = JSON.parse(await readFile(indexFile, "utf8")) as unknown;
          if (isRecord(indexData)) {
            originalPath = typeof indexData.originalPath === "string" ? indexData.originalPath : "";
            const entries = Array.isArray(indexData.entries) ? indexData.entries : [];
            for (const entry of entries) {
              if (!isRecord(entry)) continue;
              const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "";
              const fullPath = typeof entry.fullPath === "string" ? entry.fullPath : "";
              const projectPath =
                typeof entry.projectPath === "string" ? entry.projectPath : originalPath;
              if (!sessionId || !fullPath) continue;
              if (!(await fileExists(fullPath))) continue;
              if ((await normalizePath(projectPath)) !== "" && !activeCwds.has(await normalizePath(projectPath))) {
                continue;
              }
              indexedIds.add(sessionId);
              sessions.push({ sessionId, filePath: fullPath });
            }
          }
        } catch {
          // Ignore malformed indexes; unindexed .jsonl files below may still work.
        }
      }

      for (const entry of await safeReaddir(projectDir)) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const sessionId = basename(entry.name, ".jsonl");
        if (indexedIds.has(sessionId)) continue;

        const filePath = join(projectDir, entry.name);
        let fileProjectPath = originalPath;
        if (!fileProjectPath) {
          fileProjectPath = await readCwdFromJsonl(filePath);
        }
        if (!fileProjectPath && dirent.name.startsWith("-")) {
          fileProjectPath = dirent.name.replaceAll("-", "/");
        }
        if (!activeCwds.has(await normalizePath(fileProjectPath))) continue;
        sessions.push({ sessionId, filePath });
      }
    }

    return sessions;
  }

  private async scanCodexProjects(activeCwds: Set<string>): Promise<SessionInfo[]> {
    const codexHomePath = this.options.config?.codexHomePath;
    if (!codexHomePath) return [];
    const sessions = await scanCodexSessionsForCwds(codexHomePath, activeCwds);
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      filePath: session.filePath
    }));
  }

  async readNewLines(session: TrackedSession, filePath: string): Promise<Record<string, unknown>[]> {
    const entries: Record<string, unknown>[] = [];
    let handle;

    try {
      handle = await open(filePath, "r");
      const fileStat = await handle.stat();
      const fileSize = fileStat.size;

      if (session.lastByteOffset > fileSize) {
        session.lastByteOffset = 0;
      }

      if (session.lastByteOffset > 0) {
        const firstByte = Buffer.alloc(1);
        const readResult = await handle.read(firstByte, 0, 1, session.lastByteOffset);
        if (readResult.bytesRead > 0 && firstByte.toString("utf8") !== "{") {
          session.lastByteOffset = await scanToNextLine(handle, session.lastByteOffset, fileSize);
          return [];
        }
      }

      const rest = Buffer.alloc(Math.max(0, fileSize - session.lastByteOffset));
      if (rest.length === 0) return [];
      await handle.read(rest, 0, rest.length, session.lastByteOffset);

      let safeOffset = session.lastByteOffset;
      let cursor = 0;
      while (cursor < rest.length) {
        const newlineIdx = rest.indexOf(0x0a, cursor);
        const lineEnd = newlineIdx === -1 ? rest.length : newlineIdx;
        const lineBuffer = rest.subarray(cursor, lineEnd);
        const rawLine = lineBuffer.toString("utf8");
        const parsed = TranscriptParser.parseLine(rawLine);
        if (parsed) {
          entries.push(parsed);
          safeOffset = session.lastByteOffset + lineEnd + (newlineIdx === -1 ? 0 : 1);
        } else if (rawLine.trim()) {
          break;
        } else {
          safeOffset = session.lastByteOffset + lineEnd + (newlineIdx === -1 ? 0 : 1);
        }
        if (newlineIdx === -1) break;
        cursor = newlineIdx + 1;
      }

      session.lastByteOffset = safeOffset;
    } catch {
      return entries;
    } finally {
      await handle?.close();
    }

    return entries;
  }

  async checkForUpdates(activeSessions: Set<string> | Record<string, string>): Promise<NewMessage[]> {
    const newMessages: NewMessage[] = [];
    const activeSessionIds = activeSessions instanceof Set ? activeSessions : new Set(Object.values(activeSessions));
    const sessionWindows = activeSessions instanceof Set ? {} : invertSessionMap(activeSessions);
    const sessions = await this.scanProjects();

    for (const sessionInfo of sessions) {
      if (!activeSessionIds.has(sessionInfo.sessionId)) continue;

      let tracked = this.state.getSession(sessionInfo.sessionId);
      const fileStat = await safeStat(sessionInfo.filePath);
      if (!fileStat) continue;

      if (!tracked) {
        tracked = new TrackedSession(sessionInfo.sessionId, sessionInfo.filePath, fileStat.size);
        this.state.updateSession(tracked);
        this.fileMtimes[sessionInfo.sessionId] = fileStat.mtimeMs;
        continue;
      }

      const lastMtime = this.fileMtimes[sessionInfo.sessionId] ?? 0;
      if (fileStat.mtimeMs <= lastMtime && fileStat.size <= tracked.lastByteOffset) {
        continue;
      }

      const newEntries = await this.readNewLines(tracked, sessionInfo.filePath);
      this.fileMtimes[sessionInfo.sessionId] = fileStat.mtimeMs;

      const carry = this.pendingTools[sessionInfo.sessionId] ?? {};
      const [parsedEntries, remaining] = TranscriptParser.parseEntries(newEntries, carry);
      if (Object.keys(remaining).length > 0) {
        this.pendingTools[sessionInfo.sessionId] = remaining;
      } else {
        delete this.pendingTools[sessionInfo.sessionId];
      }

      const windowIds = sessionWindows[sessionInfo.sessionId] ?? [null];
      for (const entry of parsedEntries) {
        if (!entry.text && !entry.imageData) continue;
        if (entry.role === "user" && this.options.config?.showUserMessages === false) continue;
        for (const windowId of windowIds) {
          newMessages.push({
            sessionId: sessionInfo.sessionId,
            windowId,
            text: entry.text,
            isComplete: true,
            contentType: entry.contentType,
            toolUseId: entry.toolUseId ?? null,
            role: entry.role,
            toolName: entry.toolName ?? null,
            imageData: entry.imageData ?? null
          });
        }
      }

      this.state.updateSession(tracked);
    }

    await this.state.saveIfDirty();
    return newMessages;
  }

  async loadCurrentSessionMap(): Promise<Record<string, string>> {
    const currentMap =
      this.options.config?.agentType === "codex"
        ? await this.loadCurrentCodexSessionMap()
        : await this.loadSessionMapFile();
    return this.filterBoundWindows(currentMap);
  }

  private filterBoundWindows(currentMap: Record<string, string>): Record<string, string> {
    const boundWindowIds = this.getBoundWindowIds();
    if (!boundWindowIds) return currentMap;
    const filtered: Record<string, string> = {};
    for (const [windowId, sessionId] of Object.entries(currentMap)) {
      if (boundWindowIds.has(windowId)) filtered[windowId] = sessionId;
    }
    return filtered;
  }

  private getBoundWindowIds(): Set<string> | null {
    return this.options.boundWindowIds ? new Set(this.options.boundWindowIds()) : null;
  }

  private async loadSessionMapFile(): Promise<Record<string, string>> {
    const sessionMapFile = this.options.config?.sessionMapFile;
    const tmuxSessionName = this.options.config?.tmuxSessionName;
    if (!sessionMapFile || !tmuxSessionName || !existsSync(sessionMapFile)) {
      return {};
    }

    try {
      const sessionMap = JSON.parse(await readFile(sessionMapFile, "utf8")) as unknown;
      if (!isRecord(sessionMap)) return {};
      const prefix = `${tmuxSessionName}:`;
      const windowToSession: Record<string, string> = {};
      for (const [key, info] of Object.entries(sessionMap)) {
        if (!key.startsWith(prefix) || !isRecord(info)) continue;
        const sessionId = typeof info.session_id === "string" ? info.session_id : "";
        if (sessionId) {
          windowToSession[key.slice(prefix.length)] = sessionId;
        }
      }
      return windowToSession;
    } catch {
      return {};
    }
  }

  private async loadCurrentCodexSessionMap(): Promise<Record<string, string>> {
    const codexHomePath = this.options.config?.codexHomePath;
    if (!codexHomePath || !this.options.tmuxManager) return {};

    const windows = (await this.options.tmuxManager.listWindows()) as TmuxWindow[];
    const boundWindowIds = this.getBoundWindowIds();
    const requireHookMapping = boundWindowIds !== null;
    const activeCwds = new Set<string>();
    const cwdWindowCounts = new Map<string, number>();
    const normalizedWindows: Array<{ windowId: string; cwd: string }> = [];
    for (const window of windows) {
      if (boundWindowIds && !boundWindowIds.has(window.windowId)) continue;
      const cwd = await normalizePath(window.cwd);
      if (!cwd) continue;
      activeCwds.add(cwd);
      cwdWindowCounts.set(cwd, (cwdWindowCounts.get(cwd) ?? 0) + 1);
      normalizedWindows.push({ windowId: window.windowId, cwd });
    }

    const sessions = await scanCodexSessionsForCwds(codexHomePath, activeCwds);
    const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    const latestByCwd = new Map<string, string>();
    for (const session of sessions) {
      if (!latestByCwd.has(session.cwd)) {
        latestByCwd.set(session.cwd, session.sessionId);
      }
    }

    const result: Record<string, string> = {};
    const hooked = await this.loadSessionMapFile();
    const directHookedSessions = new Map<string, CodexSessionInfo | null>();
    for (const window of normalizedWindows) {
      const hookedSessionId = hooked[window.windowId];
      let hookedSession = hookedSessionId ? sessionsById.get(hookedSessionId) : undefined;
      if (hookedSessionId && !hookedSession) {
        if (!directHookedSessions.has(hookedSessionId)) {
          directHookedSessions.set(hookedSessionId, await findCodexSessionInfo(codexHomePath, hookedSessionId));
        }
        hookedSession = directHookedSessions.get(hookedSessionId) ?? undefined;
      }
      if (hookedSession?.cwd === window.cwd) {
        result[window.windowId] = hookedSession.sessionId;
        continue;
      }

      if (requireHookMapping) continue;
      if ((cwdWindowCounts.get(window.cwd) ?? 0) === 1) {
        const sessionId = latestByCwd.get(window.cwd);
        if (sessionId) result[window.windowId] = sessionId;
      }
    }
    return result;
  }

  async cleanupAllStaleSessions(): Promise<void> {
    const currentMap = await this.loadCurrentSessionMap();
    const activeSessionIds = new Set(Object.values(currentMap));
    for (const sessionId of Object.keys(this.state.trackedSessions)) {
      if (!activeSessionIds.has(sessionId)) {
        this.state.removeSession(sessionId);
        delete this.fileMtimes[sessionId];
      }
    }
    await this.state.saveIfDirty();
  }

  async detectAndCleanupChanges(): Promise<Record<string, string>> {
    const currentMap = await this.loadCurrentSessionMap();
    const sessionsToRemove = new Set<string>();

    for (const [windowId, oldSessionId] of Object.entries(this.lastSessionMap)) {
      const newSessionId = currentMap[windowId];
      if (newSessionId && newSessionId !== oldSessionId) {
        sessionsToRemove.add(oldSessionId);
      }
    }

    for (const [windowId, oldSessionId] of Object.entries(this.lastSessionMap)) {
      if (!(windowId in currentMap)) {
        sessionsToRemove.add(oldSessionId);
      }
    }

    for (const sessionId of sessionsToRemove) {
      this.state.removeSession(sessionId);
      delete this.fileMtimes[sessionId];
    }
    await this.state.saveIfDirty();
    this.lastSessionMap = currentMap;
    return currentMap;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.monitorLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.sleepResolve?.();
    this.sleepResolve = null;
    await this.loopPromise;
    this.loopPromise = null;
    await this.state.save();
  }

  async tick(): Promise<void> {
    const currentMap = await this.detectAndCleanupChanges();
    const messages = await this.checkForUpdates(currentMap);
    if (!this.messageCallback) return;
    for (const message of messages) {
      try {
        await this.messageCallback(message);
      } catch {
        // Keep monitoring even if Telegram delivery or user callback fails.
      }
    }
  }

  private async monitorLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch {
        // Keep the loop alive after transient filesystem/tmux errors.
      }
      if (this.running) {
        await this.sleepPollInterval();
      }
    }
  }

  private sleepPollInterval(): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sleepResolve = null;
        resolve();
      }, this.pollInterval * 1000);
    });
  }
}

async function scanToNextLine(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  fileSize: number
): Promise<number> {
  const length = Math.max(0, fileSize - offset);
  if (length === 0) return offset;
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, offset);
  const newlineIdx = buffer.indexOf(0x0a);
  return newlineIdx === -1 ? fileSize : offset + newlineIdx + 1;
}

async function normalizePath(path: string): Promise<string> {
  if (!path) return "";
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function safeReaddir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await safeStat(path)) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invertSessionMap(windowToSession: Record<string, string>): Record<string, Array<string | null>> {
  const result: Record<string, Array<string | null>> = {};
  for (const [windowId, sessionId] of Object.entries(windowToSession)) {
    result[sessionId] ??= [];
    result[sessionId].push(windowId);
  }
  return result;
}
