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
}
