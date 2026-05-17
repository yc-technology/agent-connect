import type Database from "better-sqlite3";
import type { AgentType } from "./hookTypes.js";

export interface WindowRow {
  window_id: string;
  display_name: string;
  cwd: string;
  created_at: number;
}

export interface SessionRow {
  session_id: string;
  window_id: string;
  agent_type: AgentType;
  transcript_path: string;
  cwd: string;
  source: string | null;
  last_byte_offset: number;
  started_at: number;
}

export interface RegisterSessionArgs {
  sessionId: string;
  windowId: string;
  agentType: AgentType;
  transcriptPath: string;
  cwd: string;
  source?: string;
  startedAt?: number;
  lastByteOffset?: number;
}

const SCHEMA_VERSION = "1";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS windows (
  window_id    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  window_id        TEXT NOT NULL,
  agent_type       TEXT NOT NULL,
  transcript_path  TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  source           TEXT,
  last_byte_offset INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_window ON sessions(window_id);

CREATE TABLE IF NOT EXISTS thread_bindings (
  user_id                INTEGER NOT NULL,
  thread_id              INTEGER NOT NULL,
  window_id              TEXT NOT NULL,
  group_chat_id          INTEGER,
  topic_probe_message_id INTEGER,
  bound_at               INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bindings_window ON thread_bindings(window_id);

CREATE TABLE IF NOT EXISTS user_window_offsets (
  user_id     INTEGER NOT NULL,
  window_id   TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE CASCADE
);
`;

export class SessionRegistry {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Database.Database) {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    const existing = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("schema_version") as { value: string } | undefined;
    if (!existing) {
      db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
        "schema_version",
        SCHEMA_VERSION
      );
    }
  }

  close(): void {
    this.db.close();
  }

  upsertWindow(windowId: string, displayName: string, cwd: string): void {
    this.db
      .prepare(
        `INSERT INTO windows (window_id, display_name, cwd, created_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(window_id) DO UPDATE SET
           display_name = excluded.display_name,
           cwd = excluded.cwd`
      )
      .run(windowId, displayName, cwd, Date.now());
  }

  deleteWindow(windowId: string): void {
    this.db.prepare("DELETE FROM windows WHERE window_id = ?").run(windowId);
  }

  listLiveWindows(): WindowRow[] {
    return this.db
      .prepare("SELECT window_id, display_name, cwd, created_at FROM windows ORDER BY window_id")
      .all() as WindowRow[];
  }

  registerSession(args: RegisterSessionArgs): void {
    const startedAt = args.startedAt ?? Date.now();
    const lastByteOffset = args.lastByteOffset ?? 0;
    const tx = this.db.transaction((a: RegisterSessionArgs) => {
      this.db.prepare("DELETE FROM sessions WHERE window_id = ?").run(a.windowId);
      this.db
        .prepare(
          `INSERT INTO sessions
             (session_id, window_id, agent_type, transcript_path, cwd, source, last_byte_offset, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          a.sessionId,
          a.windowId,
          a.agentType,
          a.transcriptPath,
          a.cwd,
          a.source ?? null,
          lastByteOffset,
          startedAt
        );
    });
    tx(args);
  }

  endSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  getSessionByWindow(windowId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE window_id = ?")
      .get(windowId) as SessionRow | undefined;
    return row ?? null;
  }

  allLiveSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions").all() as SessionRow[];
  }

  setOffset(sessionId: string, offset: number): void {
    this.db
      .prepare("UPDATE sessions SET last_byte_offset = ? WHERE session_id = ?")
      .run(offset, sessionId);
  }

  bindThread(userId: number, threadId: number, windowId: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_bindings (user_id, thread_id, window_id, bound_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, thread_id) DO UPDATE SET
           window_id = excluded.window_id,
           bound_at = excluded.bound_at`
      )
      .run(userId, threadId, windowId, Date.now());
  }

  unbindThread(userId: number, threadId: number): string | null {
    const row = this.db
      .prepare("SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
      .get(userId, threadId) as { window_id: string } | undefined;
    if (!row) return null;
    this.db
      .prepare("DELETE FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
      .run(userId, threadId);
    return row.window_id;
  }

  resolveWindowForThread(userId: number, threadId: number): string | null {
    const row = this.db
      .prepare("SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
      .get(userId, threadId) as { window_id: string } | undefined;
    return row?.window_id ?? null;
  }

  *iterThreadBindings(): IterableIterator<[number, number, string]> {
    const rows = this.db
      .prepare(
        "SELECT user_id, thread_id, window_id FROM thread_bindings ORDER BY user_id, thread_id"
      )
      .all() as Array<{ user_id: number; thread_id: number; window_id: string }>;
    for (const r of rows) yield [r.user_id, r.thread_id, r.window_id];
  }

  setGroupChatId(userId: number, threadId: number, chatId: number): void {
    this.db
      .prepare(
        `UPDATE thread_bindings SET group_chat_id = ?
           WHERE user_id = ? AND thread_id = ?`
      )
      .run(chatId, userId, threadId);
  }

  resolveChatId(userId: number, threadId: number | null): number {
    if (threadId === null) return userId;
    const row = this.db
      .prepare(
        "SELECT group_chat_id FROM thread_bindings WHERE user_id = ? AND thread_id = ? AND group_chat_id IS NOT NULL"
      )
      .get(userId, threadId) as { group_chat_id: number } | undefined;
    return row?.group_chat_id ?? userId;
  }

  setTopicProbeMessageId(userId: number, threadId: number, messageId: number): void {
    this.db
      .prepare(
        `UPDATE thread_bindings SET topic_probe_message_id = ?
           WHERE user_id = ? AND thread_id = ?`
      )
      .run(messageId, userId, threadId);
  }

  getTopicProbeMessageId(userId: number, threadId: number): number | null {
    const row = this.db
      .prepare(
        "SELECT topic_probe_message_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?"
      )
      .get(userId, threadId) as { topic_probe_message_id: number | null } | undefined;
    return row?.topic_probe_message_id ?? null;
  }

  updateUserWindowOffset(userId: number, windowId: string, offset: number): void {
    this.db
      .prepare(
        `INSERT INTO user_window_offsets (user_id, window_id, byte_offset)
           VALUES (?, ?, ?)
         ON CONFLICT(user_id, window_id) DO UPDATE SET
           byte_offset = excluded.byte_offset`
      )
      .run(userId, windowId, offset);
  }

  getUserWindowOffset(userId: number, windowId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT byte_offset FROM user_window_offsets WHERE user_id = ? AND window_id = ?"
      )
      .get(userId, windowId) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? null;
  }

  async withSessionLock<T>(
    sessionId: string,
    fn: (session: SessionRow) => Promise<T>
  ): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    let resolveNext: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveNext = r;
    });
    // Replace the slot synchronously so following calls queue behind us.
    this.locks.set(sessionId, gate);
    try {
      await prev;
      const session = this.getSession(sessionId);
      if (!session) {
        throw new Error(`withSessionLock: session ${sessionId} not found`);
      }
      return await fn(session);
    } finally {
      resolveNext();
      if (this.locks.get(sessionId) === gate) this.locks.delete(sessionId);
    }
  }
}
