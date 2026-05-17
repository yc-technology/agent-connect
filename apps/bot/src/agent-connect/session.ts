import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  findCodexSession,
  listCodexSessionsForDirectory
} from "./codexSessions.js";
import type { AgentType } from "./claudeCommand.js";
import type { Config } from "./config.js";
import { isForumThreadId } from "./telegramThread.js";
import { TranscriptParser } from "./transcriptParser.js";
import type { TmuxManager, TmuxWindow } from "./tmuxManager.js";

export interface WindowStateData {
  session_id?: unknown;
  cwd?: unknown;
  window_name?: unknown;
}

export class WindowState {
  constructor(
    public sessionId = "",
    public cwd = "",
    public windowName = ""
  ) {}

  toDict(): { session_id: string; cwd: string; window_name?: string } {
    const data: { session_id: string; cwd: string; window_name?: string } = {
      session_id: this.sessionId,
      cwd: this.cwd
    };
    if (this.windowName) data.window_name = this.windowName;
    return data;
  }

  static fromDict(data: WindowStateData): WindowState {
    return new WindowState(
      typeof data.session_id === "string" ? data.session_id : "",
      typeof data.cwd === "string" ? data.cwd : "",
      typeof data.window_name === "string" ? data.window_name : ""
    );
  }
}

export interface ClaudeSession {
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
  timestamp?: string | null;
}

export interface SessionManagerOptions {
  config: Pick<
    Config,
    "stateFile" | "sessionMapFile" | "tmuxSessionName" | "claudeProjectsPath" | "codexHomePath" | "agentType"
  >;
  tmuxManager?: Pick<TmuxManager, "listWindows" | "findWindowById" | "sendKeys">;
  loadState?: boolean;
}

interface PersistedState {
  window_states?: Record<string, WindowStateData>;
  user_window_offsets?: Record<string, Record<string, number>>;
  thread_bindings?: Record<string, Record<string, string>>;
  window_display_names?: Record<string, string>;
  group_chat_ids?: Record<string, number>;
  topic_probe_message_ids?: Record<string, number>;
}

export class SessionManager {
  windowStates: Record<string, WindowState> = {};
  userWindowOffsets: Record<number, Record<string, number>> = {};
  threadBindings: Record<number, Record<number, string>> = {};
  windowDisplayNames: Record<string, string> = {};
  groupChatIds: Record<string, number> = {};
  topicProbeMessageIds: Record<string, number> = {};

  constructor(private readonly options: SessionManagerOptions) {
    if (options.loadState !== false) {
      this.loadState();
    }
  }

  saveState(): void {
    const state = {
      window_states: Object.fromEntries(
        Object.entries(this.windowStates).map(([key, value]) => [key, value.toDict()])
      ),
      user_window_offsets: stringifyNestedNumberKeys(this.userWindowOffsets),
      thread_bindings: stringifyNestedNumberKeys(this.threadBindings),
      window_display_names: this.windowDisplayNames,
      group_chat_ids: this.groupChatIds,
      topic_probe_message_ids: this.topicProbeMessageIds
    };
    atomicWriteJsonSync(this.options.config.stateFile, state);
  }

  isWindowId(key: string): boolean {
    return key.startsWith("@") && key.length > 1 && /^\d+$/.test(key.slice(1));
  }

  loadState(): void {
    if (!existsSync(this.options.config.stateFile)) return;

    try {
      const state = JSON.parse(readFileSync(this.options.config.stateFile, "utf8")) as PersistedState;
      this.windowStates = Object.fromEntries(
        Object.entries(state.window_states ?? {}).map(([key, value]) => [
          key,
          WindowState.fromDict(value)
        ])
      );
      this.userWindowOffsets = parseNestedNumberKeyRecord(state.user_window_offsets ?? {});
      this.threadBindings = parseNestedStringRecord(state.thread_bindings ?? {});
      this.windowDisplayNames = state.window_display_names ?? {};
      this.groupChatIds = Object.fromEntries(
        Object.entries(state.group_chat_ids ?? {})
          .map(([key, value]) => [key, Number(value)] as const)
          .filter(([key]) => {
            const tidStr = key.split(":")[1];
            const tid = tidStr === undefined ? NaN : Number(tidStr);
            return isForumThreadId(Number.isFinite(tid) ? tid : null);
          })
      );
      this.topicProbeMessageIds = Object.fromEntries(
        Object.entries(state.topic_probe_message_ids ?? {})
          .map(([key, value]) => [key, Number(value)])
          .filter(([, value]) => Number.isSafeInteger(value))
      );
    } catch {
      this.windowStates = {};
      this.userWindowOffsets = {};
      this.threadBindings = {};
      this.windowDisplayNames = {};
      this.groupChatIds = {};
      this.topicProbeMessageIds = {};
    }
  }

  async resolveStaleIds(): Promise<void> {
    const windows = this.options.tmuxManager ? await this.options.tmuxManager.listWindows() : [];
    const liveByName: Record<string, string> = {};
    const liveIds = new Set<string>();
    for (const window of windows as TmuxWindow[]) {
      liveByName[window.windowName] = window.windowId;
      liveIds.add(window.windowId);
    }

    let changed = false;
    const newWindowStates: Record<string, WindowState> = {};

    for (const [key, state] of Object.entries(this.windowStates)) {
      if (this.isWindowId(key)) {
        if (liveIds.has(key)) {
          newWindowStates[key] = state;
        } else {
          const display = this.windowDisplayNames[key] ?? state.windowName ?? key;
          const newId = liveByName[display];
          if (newId) {
            state.windowName = display;
            newWindowStates[newId] = state;
            this.windowDisplayNames[newId] = display;
            delete this.windowDisplayNames[key];
          }
          changed = true;
        }
      } else {
        const newId = liveByName[key];
        if (newId) {
          state.windowName = key;
          newWindowStates[newId] = state;
          this.windowDisplayNames[newId] = key;
        }
        changed = true;
      }
    }
    this.windowStates = newWindowStates;

    for (const [uidRaw, bindings] of Object.entries(this.threadBindings)) {
      const uid = Number(uidRaw);
      const newBindings: Record<number, string> = {};
      for (const [tidRaw, value] of Object.entries(bindings)) {
        const tid = Number(tidRaw);
        if (this.isWindowId(value)) {
          if (liveIds.has(value)) {
            newBindings[tid] = value;
          } else {
            const display = this.windowDisplayNames[value] ?? value;
            const newId = liveByName[display];
            if (newId) {
              newBindings[tid] = newId;
              this.windowDisplayNames[newId] = display;
            }
            changed = true;
          }
        } else {
          const newId = liveByName[value];
          if (newId) {
            newBindings[tid] = newId;
            this.windowDisplayNames[newId] = value;
          }
          changed = true;
        }
      }
      if (Object.keys(newBindings).length > 0) {
        this.threadBindings[uid] = newBindings;
      } else {
        delete this.threadBindings[uid];
      }
    }

    for (const [uidRaw, offsets] of Object.entries(this.userWindowOffsets)) {
      const uid = Number(uidRaw);
      const newOffsets: Record<string, number> = {};
      for (const [key, offset] of Object.entries(offsets)) {
        if (this.isWindowId(key)) {
          if (liveIds.has(key)) {
            newOffsets[key] = offset;
          } else {
            const display = this.windowDisplayNames[key] ?? key;
            const newId = liveByName[display];
            if (newId) newOffsets[newId] = offset;
            changed = true;
          }
        } else {
          const newId = liveByName[key];
          if (newId) newOffsets[newId] = offset;
          changed = true;
        }
      }
      this.userWindowOffsets[uid] = newOffsets;
    }

    if (changed) this.saveState();
    await this.cleanupStaleSessionMapEntries(liveIds);
    await this.cleanupOldFormatSessionMapKeys();
  }

  async cleanupOldFormatSessionMapKeys(): Promise<void> {
    const sessionMap = await this.readSessionMap();
    if (!sessionMap) return;
    const prefix = `${this.options.config.tmuxSessionName}:`;
    let changed = false;
    for (const key of Object.keys(sessionMap)) {
      if (key.startsWith(prefix) && !this.isWindowId(key.slice(prefix.length))) {
        delete sessionMap[key];
        changed = true;
      }
    }
    if (changed) atomicWriteJsonSync(this.options.config.sessionMapFile, sessionMap);
  }

  async cleanupStaleSessionMapEntries(liveIds: Set<string>): Promise<void> {
    const sessionMap = await this.readSessionMap();
    if (!sessionMap) return;
    const prefix = `${this.options.config.tmuxSessionName}:`;
    let changed = false;
    for (const key of Object.keys(sessionMap)) {
      if (
        key.startsWith(prefix) &&
        this.isWindowId(key.slice(prefix.length)) &&
        !liveIds.has(key.slice(prefix.length))
      ) {
        delete sessionMap[key];
        changed = true;
      }
    }
    if (changed) atomicWriteJsonSync(this.options.config.sessionMapFile, sessionMap);
  }

  getDisplayName(windowId: string): string {
    return this.windowDisplayNames[windowId] ?? windowId;
  }

  updateDisplayName(windowId: string, newName: string): void {
    this.windowDisplayNames[windowId] = newName;
    if (this.windowStates[windowId]) {
      this.windowStates[windowId].windowName = newName;
    }
    this.saveState();
  }

  setGroupChatId(userId: number, threadId: number | null, chatId: number): void {
    if (!isForumThreadId(threadId)) return;
    const key = `${userId}:${threadId}`;
    if (this.groupChatIds[key] !== chatId) {
      this.groupChatIds[key] = chatId;
      this.saveState();
    }
  }

  resolveChatId(userId: number, threadId: number | null = null): number {
    if (isForumThreadId(threadId)) {
      const groupId = this.groupChatIds[`${userId}:${threadId}`];
      if (groupId !== undefined) return groupId;
    }
    return userId;
  }

  setTopicProbeMessageId(userId: number, threadId: number, messageId: number): void {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    const key = topicKey(userId, threadId);
    if (this.topicProbeMessageIds[key] !== messageId) {
      this.topicProbeMessageIds[key] = messageId;
      this.saveState();
    }
  }

  getTopicProbeMessageId(userId: number, threadId: number): number | null {
    return this.topicProbeMessageIds[topicKey(userId, threadId)] ?? null;
  }

  async waitForSessionMapEntry(
    windowId: string,
    timeout = 5.0,
    interval = 0.5
  ): Promise<boolean> {
    const key = `${this.options.config.tmuxSessionName}:${windowId}`;
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const sessionMap = await this.readSessionMap();
      const info = sessionMap?.[key];
      if (isRecord(info) && typeof info.session_id === "string" && info.session_id) {
        await this.loadSessionMap();
        return true;
      }
      await sleep(interval * 1000);
    }
    return false;
  }

  async loadSessionMap(): Promise<void> {
    const sessionMap = await this.readSessionMap();
    if (!sessionMap) return;

    const prefix = `${this.options.config.tmuxSessionName}:`;
    const validWindowIds = new Set<string>();
    let changed = false;

    for (const [key, info] of Object.entries(sessionMap)) {
      if (!key.startsWith(prefix) || !isRecord(info)) continue;
      const windowId = key.slice(prefix.length);
      if (!this.isWindowId(windowId)) continue;
      validWindowIds.add(windowId);

      const newSessionId = typeof info.session_id === "string" ? info.session_id : "";
      const newCwd = typeof info.cwd === "string" ? info.cwd : "";
      const newWindowName = typeof info.window_name === "string" ? info.window_name : "";
      if (!newSessionId) continue;

      const state = this.getWindowState(windowId);
      if (state.sessionId !== newSessionId || state.cwd !== newCwd) {
        state.sessionId = newSessionId;
        state.cwd = newCwd;
        changed = true;
      }
      if (newWindowName) {
        state.windowName = newWindowName;
        if (this.windowDisplayNames[windowId] !== newWindowName) {
          this.windowDisplayNames[windowId] = newWindowName;
          changed = true;
        }
      }
    }

    for (const windowId of Object.keys(this.windowStates)) {
      if (!validWindowIds.has(windowId)) {
        delete this.windowStates[windowId];
        changed = true;
      }
    }

    if (changed) this.saveState();
  }

  getWindowState(windowId: string): WindowState {
    this.windowStates[windowId] ??= new WindowState();
    return this.windowStates[windowId];
  }

  clearWindowSession(windowId: string): void {
    this.getWindowState(windowId).sessionId = "";
    this.saveState();
  }

  encodeCwd(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  }

  buildSessionFilePath(sessionId: string, cwd: string): string | null {
    if (!sessionId || !cwd) return null;
    return join(this.options.config.claudeProjectsPath, this.encodeCwd(cwd), `${sessionId}.jsonl`);
  }

  async getSessionDirect(
    sessionId: string,
    cwd: string,
    agentType: AgentType = this.options.config.agentType
  ): Promise<ClaudeSession | null> {
    if (agentType === "codex") {
      const session = await findCodexSession(this.options.config.codexHomePath, sessionId);
      if (!session) return null;
      return {
        sessionId: session.sessionId,
        summary: session.summary,
        messageCount: session.messageCount,
        filePath: session.filePath,
        agentType: "codex"
      };
    }

    let filePath = this.buildSessionFilePath(sessionId, cwd);
    if (!filePath || !existsSync(filePath)) {
      filePath = await this.findSessionFileByGlob(sessionId);
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

  async listSessionsForDirectory(
    cwd: string,
    agentType: AgentType = this.options.config.agentType
  ): Promise<ClaudeSession[]> {
    if (agentType === "codex") {
      const sessions = await listCodexSessionsForDirectory(this.options.config.codexHomePath, cwd);
      return sessions.map((session) => ({
        sessionId: session.sessionId,
        summary: session.summary,
        messageCount: session.messageCount,
        filePath: session.filePath,
        agentType: "codex"
      }));
    }

    const projectDir = join(this.options.config.claudeProjectsPath, this.encodeCwd(cwd));
    if (!existsSync(projectDir)) return [];

    const files = (await readdir(projectDir))
      .filter((name) => name.endsWith(".jsonl") && name !== "sessions-index.json")
      .map((name) => join(projectDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 10);

    const sessions: ClaudeSession[] = [];
    for (const file of files) {
      const sessionId = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
      const session = await this.getSessionDirect(sessionId, cwd);
      if (session && session.messageCount > 0) sessions.push(session);
    }
    return sessions;
  }

  async resolveSessionForWindow(windowId: string): Promise<ClaudeSession | null> {
    let state = this.getWindowState(windowId);
    if (!state.sessionId || !state.cwd) {
      await this.loadSessionMap();
      state = this.getWindowState(windowId);
    }
    if (!state.sessionId || !state.cwd) return null;

    const session = await this.getSessionDirect(state.sessionId, state.cwd);
    if (session) return session;

    state.sessionId = "";
    state.cwd = "";
    this.saveState();
    return null;
  }

  updateUserWindowOffset(userId: number, windowId: string, offset: number): void {
    this.userWindowOffsets[userId] ??= {};
    this.userWindowOffsets[userId][windowId] = offset;
    this.saveState();
  }

  bindThread(userId: number, threadId: number, windowId: string, windowName = ""): void {
    this.threadBindings[userId] ??= {};
    this.threadBindings[userId][threadId] = windowId;
    if (windowName) this.windowDisplayNames[windowId] = windowName;
    this.saveState();
  }

  unbindThread(userId: number, threadId: number): string | null {
    const bindings = this.threadBindings[userId];
    if (!bindings || !(threadId in bindings)) return null;
    const windowId = bindings[threadId] ?? null;
    delete bindings[threadId];
    if (Object.keys(bindings).length === 0) delete this.threadBindings[userId];
    delete this.topicProbeMessageIds[topicKey(userId, threadId)];
    this.saveState();
    return windowId;
  }

  getWindowForThread(userId: number, threadId: number): string | null {
    return this.threadBindings[userId]?.[threadId] ?? null;
  }

  resolveWindowForThread(userId: number, threadId: number | null): string | null {
    if (threadId === null) return null;
    return this.getWindowForThread(userId, threadId);
  }

  *iterThreadBindings(): IterableIterator<[number, number, string]> {
    for (const [userId, bindings] of Object.entries(this.threadBindings)) {
      for (const [threadId, windowId] of Object.entries(bindings)) {
        yield [Number(userId), Number(threadId), windowId];
      }
    }
  }

  async findUsersForSession(sessionId: string): Promise<Array<[number, string, number]>> {
    await this.loadSessionMap();
    const result: Array<[number, string, number]> = [];
    for (const [userId, threadId, windowId] of this.iterThreadBindings()) {
      const resolved = await this.resolveSessionForWindow(windowId);
      if (resolved?.sessionId === sessionId) {
        result.push([userId, windowId, threadId]);
      }
    }
    return result;
  }

  findUsersForWindow(windowId: string): Array<[number, string, number]> {
    const result: Array<[number, string, number]> = [];
    for (const [userId, threadId, boundWindowId] of this.iterThreadBindings()) {
      if (boundWindowId === windowId) {
        result.push([userId, boundWindowId, threadId]);
      }
    }
    return result;
  }

  async sendToWindow(windowId: string, text: string): Promise<[boolean, string]> {
    const window = this.options.tmuxManager
      ? await this.options.tmuxManager.findWindowById(windowId)
      : null;
    if (!window) return [false, "Window not found (may have been closed)"];

    const success = await this.options.tmuxManager!.sendKeys(window.windowId, text);
    return success ? [true, `Sent to ${this.getDisplayName(windowId)}`] : [false, "Failed to send keys"];
  }

  async getRecentMessages(
    windowId: string,
    options: { startByte?: number; endByte?: number | null } = {}
  ): Promise<[HistoryMessage[], number]> {
    const session = await this.resolveSessionForWindow(windowId);
    if (!session?.filePath || !existsSync(session.filePath)) return [[], 0];

    const startByte = options.startByte ?? 0;
    const endByte = options.endByte ?? null;
    const buffer = await readFile(session.filePath);
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

  private async readSessionMap(): Promise<Record<string, unknown> | null> {
    if (!existsSync(this.options.config.sessionMapFile)) return null;
    try {
      const data = JSON.parse(await readFile(this.options.config.sessionMapFile, "utf8")) as unknown;
      return isRecord(data) ? data : null;
    } catch {
      return null;
    }
  }

  private async findSessionFileByGlob(sessionId: string): Promise<string | null> {
    if (!existsSync(this.options.config.claudeProjectsPath)) return null;
    const dirs = await readdir(this.options.config.claudeProjectsPath, { withFileTypes: true });
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(this.options.config.claudeProjectsPath, dirent.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}

function atomicWriteJsonSync(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

function topicKey(userId: number, threadId: number): string {
  return `${userId}:${threadId}`;
}

function parseNestedNumberKeyRecord(data: Record<string, Record<string, number>>): Record<number, Record<string, number>> {
  const result: Record<number, Record<string, number>> = {};
  for (const [outerKey, inner] of Object.entries(data)) {
    result[Number(outerKey)] = inner;
  }
  return result;
}

function parseNestedStringRecord(data: Record<string, Record<string, string>>): Record<number, Record<number, string>> {
  const result: Record<number, Record<number, string>> = {};
  for (const [outerKey, inner] of Object.entries(data)) {
    result[Number(outerKey)] = Object.fromEntries(
      Object.entries(inner).map(([key, value]) => [Number(key), value])
    ) as Record<number, string>;
  }
  return result;
}

function stringifyNestedNumberKeys<T>(
  data: Record<number, Record<number | string, T>>
): Record<string, Record<string, T>> {
  return Object.fromEntries(
    Object.entries(data).map(([outerKey, inner]) => [
      outerKey,
      Object.fromEntries(Object.entries(inner).map(([key, value]) => [String(key), value]))
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
