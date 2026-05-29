import type Database from "better-sqlite3";
import type { AgentType } from "./hookTypes.js";
import { logger } from "./logger.js";

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
  -- Nullable. Becomes NULL via FK ON DELETE SET NULL when the tmux window
  -- this binding referenced is deleted (e.g. tmux server restart wipes
  -- live windows). The binding ROW survives so its anchor (last_session_id)
  -- remains available to the /join resume picker as a "previous session".
  window_id              TEXT,
  group_chat_id          INTEGER,
  topic_probe_message_id INTEGER,
  bound_at               INTEGER NOT NULL,
  -- Soft recovery anchor: the most recent session_id Claude/Codex emitted on
  -- this binding's window. Populated by registerSession on every SessionStart
  -- (incl. lazyRegisterIfMissing) so the value follows manual --resume,
  -- /clear, /compact, and auto-recovery uniformly. Nullable: a freshly
  -- /joined topic whose agent hasn't fired its first SessionStart yet has no
  -- session to anchor on.
  last_session_id        TEXT,
  -- Set to 1 when the bound window vanished from tmux (statusPolling soft-
  -- delete path). The /join flow uses last_session_id to default-highlight
  -- the previous session in the resume picker; on a successful bindThread
  -- this flag is cleared via the ON CONFLICT update.
  recovery_pending       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE SET NULL
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

export interface LastEventRecord {
  event: string;
  at: number;
}

export class SessionRegistry {
  private readonly locks = new Map<string, Promise<unknown>>();
  // In-memory only — keyed by windowId so /status (which queries by window)
  // is a single lookup and SessionStart's DELETE+INSERT naturally overwrites
  // without leaving orphans. deleteWindow() clears the entry.
  private readonly lastEventByWindow = new Map<string, LastEventRecord>();

  constructor(private readonly db: Database.Database) {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    this.migrateAddLastSessionId();
    this.migrateRecoveryShape();
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

  // SQLite has no `ADD COLUMN IF NOT EXISTS`, so we PRAGMA-probe first. Cheap
  // (sub-ms) and idempotent — safe to run on every startup.
  private migrateAddLastSessionId(): void {
    const cols = this.db
      .prepare("PRAGMA table_info(thread_bindings)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "last_session_id")) return;
    this.db.exec("ALTER TABLE thread_bindings ADD COLUMN last_session_id TEXT");
    logger().info(
      { table: "thread_bindings", column: "last_session_id" },
      "registry migration: added column"
    );
  }

  // SQLite can't `ALTER COLUMN`/`ALTER CONSTRAINT`, so to (a) drop window_id's
  // NOT NULL and (b) flip the FK from CASCADE → SET NULL we use the standard
  // table-recreate dance inside a transaction. We also add recovery_pending
  // here because we're rewriting the table anyway.
  //
  // Soft-delete semantics this migration enables:
  // - When the windows row is deleted (tmux says the window is gone), the FK
  //   sets thread_bindings.window_id = NULL instead of cascading-deleting the
  //   binding row. last_session_id stays put as a "previous session" anchor.
  // - The /join picker reads recovery_pending + last_session_id to highlight
  //   the prior session as the default.
  //
  // Guard: codex review flagged that checking only `recovery_pending column
  // exists` lets a hand-edited DB with the column but old FK shape pass
  // through silently. We now verify all three required shape properties.
  private migrateRecoveryShape(): void {
    const cols = this.db
      .prepare("PRAGMA table_info(thread_bindings)")
      .all() as Array<{ name: string; notnull: number }>;
    const recoveryCol = cols.find((c) => c.name === "recovery_pending");
    const windowIdCol = cols.find((c) => c.name === "window_id");
    const fks = this.db
      .prepare("PRAGMA foreign_key_list(thread_bindings)")
      .all() as Array<{ table: string; from: string; on_delete: string }>;
    const windowFk = fks.find((fk) => fk.from === "window_id" && fk.table === "windows");
    const shapeOk =
      !!recoveryCol &&
      !!windowIdCol &&
      windowIdCol.notnull === 0 &&
      !!windowFk &&
      windowFk.on_delete === "SET NULL";
    if (shapeOk) return;

    const tx = this.db.transaction(() => {
      // foreign_keys pragma is per-connection; we leave it ON because we
      // want the SELECT below to honour any orphans. The CREATE/INSERT/DROP/
      // RENAME sequence here doesn't touch FK rows, so this is safe.
      this.db.exec(`
        CREATE TABLE thread_bindings__new (
          user_id                INTEGER NOT NULL,
          thread_id              INTEGER NOT NULL,
          window_id              TEXT,
          group_chat_id          INTEGER,
          topic_probe_message_id INTEGER,
          bound_at               INTEGER NOT NULL,
          last_session_id        TEXT,
          recovery_pending       INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, thread_id),
          FOREIGN KEY (window_id) REFERENCES windows(window_id) ON DELETE SET NULL
        );
        INSERT INTO thread_bindings__new
          (user_id, thread_id, window_id, group_chat_id, topic_probe_message_id, bound_at, last_session_id, recovery_pending)
        SELECT user_id, thread_id, window_id, group_chat_id, topic_probe_message_id, bound_at, last_session_id, 0
          FROM thread_bindings;
        DROP TABLE thread_bindings;
        ALTER TABLE thread_bindings__new RENAME TO thread_bindings;
        CREATE INDEX IF NOT EXISTS idx_bindings_window ON thread_bindings(window_id);
      `);
    });
    tx();
    logger().info(
      { table: "thread_bindings", column: "recovery_pending", fk: "window_id ON DELETE SET NULL" },
      "registry migration: recreated table for soft-delete recovery shape"
    );
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
    this.lastEventByWindow.delete(windowId);
    // Cascade clears `sessions`, `thread_bindings`, `user_window_offsets`
    // via FK ON DELETE CASCADE. Snapshot counts before for the log so a
    // surprise mass-unbind is obvious in the file.
    const sessionsBefore = (this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE window_id = ?").get(windowId) as { n: number }).n;
    const bindingsBefore = (this.db.prepare("SELECT COUNT(*) AS n FROM thread_bindings WHERE window_id = ?").get(windowId) as { n: number }).n;
    const result = this.db.prepare("DELETE FROM windows WHERE window_id = ?").run(windowId);
    if (result.changes > 0) {
      logger().info(
        { windowId, sessionsCascadeCleared: sessionsBefore, bindingsCascadeCleared: bindingsBefore },
        "registry window deleted (FK CASCADE clears sessions + thread_bindings)"
      );
    }
  }

  recordEvent(windowId: string, event: string, at: number = Date.now()): void {
    this.lastEventByWindow.set(windowId, { event, at });
  }

  getLastEvent(windowId: string): LastEventRecord | null {
    return this.lastEventByWindow.get(windowId) ?? null;
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
      // Delete by BOTH keys before inserting. `session_id` is the PRIMARY
      // KEY, so deleting only by `window_id` leaves a PK violation when the
      // same session_id is still registered against a DIFFERENT window —
      // e.g. `claude --resume <id>` spawns a new tmux window but reports the
      // same session_id, or a transient window-id reshuffle. The INSERT then
      // throws "UNIQUE constraint failed: sessions.session_id", which rejects
      // the whole SessionStart transaction: the new session row is never
      // written, drains for that window find no session, and the topic goes
      // silent. Deleting the session_id's old row too keeps registration
      // idempotent while preserving the single-live-session-per-window
      // invariant (the window_id delete still enforces that).
      this.db
        .prepare("DELETE FROM sessions WHERE window_id = ? OR session_id = ?")
        .run(a.windowId, a.sessionId);
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
      // Soft recovery anchor — covers every session-rotation flow uniformly
      // (initial /join, manual --resume, /clear, /compact). Lives in the same
      // tx as the sessions insert so DB observers can't see a half-applied
      // SessionStart.
      this.db
        .prepare("UPDATE thread_bindings SET last_session_id = ? WHERE window_id = ?")
        .run(a.sessionId, a.windowId);
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
    // ON CONFLICT clears recovery_pending — a successful (re)bind by definition
    // means the topic is back on a live window and no longer "needs recovery".
    // last_session_id is intentionally NOT touched here; registerSession will
    // overwrite it when the first SessionStart for the new window arrives.
    this.db
      .prepare(
        `INSERT INTO thread_bindings (user_id, thread_id, window_id, bound_at, recovery_pending)
           VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(user_id, thread_id) DO UPDATE SET
           window_id = excluded.window_id,
           bound_at = excluded.bound_at,
           recovery_pending = 0`
      )
      .run(userId, threadId, windowId, Date.now());
  }

  unbindThread(userId: number, threadId: number): string | null {
    const row = this.db
      .prepare("SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
      .get(userId, threadId) as { window_id: string | null } | undefined;
    if (!row) return null;
    this.db
      .prepare("DELETE FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
      .run(userId, threadId);
    return row.window_id;
  }

  // Soft-delete path: the bound window vanished from tmux (statusPolling
  // confirmed authoritatively). Keep the binding row so its last_session_id
  // remains available to the /join resume picker; just null out window_id
  // and flip recovery_pending. After the user re-/joins, bindThread will
  // clear the flag via the ON CONFLICT update path.
  markBindingForRecovery(userId: number, threadId: number): void {
    this.db
      .prepare(
        `UPDATE thread_bindings
            SET window_id = NULL,
                recovery_pending = 1
          WHERE user_id = ? AND thread_id = ?`
      )
      .run(userId, threadId);
  }

  // Resume picker default-highlight feed. Returns the anchor only if the
  // binding is in recovery_pending state — once the user re-binds, this
  // returns null so we don't over-prompt them on subsequent /joins.
  getRecoveryAnchor(userId: number, threadId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT last_session_id
           FROM thread_bindings
          WHERE user_id = ? AND thread_id = ? AND recovery_pending = 1`
      )
      .get(userId, threadId) as { last_session_id: string | null } | undefined;
    return row?.last_session_id ?? null;
  }

  resolveWindowForThread(userId: number, threadId: number): string | null {
    const row = this.db
      .prepare("SELECT window_id FROM thread_bindings WHERE user_id = ? AND thread_id = ?")
      .get(userId, threadId) as { window_id: string } | undefined;
    return row?.window_id ?? null;
  }

  // LIVE bindings only — rows with window_id IS NULL are bindings in the
  // "needs recovery" state (their tmux window vanished). Downstream consumers
  // — SessionManager.hydrateFromRegistry / resolveStaleIds, statusPolling.tick
  // — assume window_id is a real tmux ID and would crash on NULL (codex
  // caught this on review). Recovery-pending rows surface separately via
  // listRecoverableBindings / getRecoveryAnchor.
  *iterThreadBindings(): IterableIterator<[number, number, string]> {
    const rows = this.db
      .prepare(
        "SELECT user_id, thread_id, window_id FROM thread_bindings WHERE window_id IS NOT NULL ORDER BY user_id, thread_id"
      )
      .all() as Array<{ user_id: number; thread_id: number; window_id: string }>;
    for (const r of rows) yield [r.user_id, r.thread_id, r.window_id];
  }

  // Recovery-oriented view: bindings that are ACTIVELY in the "recovery
  // pending" state — their bound window vanished from tmux and they have a
  // last_session_id anchor to offer. Filtering on recovery_pending = 1 (and
  // not just "has an anchor") prevents misleading "resume your session"
  // prompts when the binding is still live (codex review).
  //
  // Stage 2a uses this to notify the user; stage 2b will iterate the same
  // rows to spawn resumed windows automatically.
  listRecoverableBindings(): Array<{
    userId: number;
    threadId: number;
    windowId: string | null;
    lastSessionId: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT user_id, thread_id, window_id, last_session_id
           FROM thread_bindings
          WHERE recovery_pending = 1 AND last_session_id IS NOT NULL
          ORDER BY user_id, thread_id`
      )
      .all() as Array<{
        user_id: number;
        thread_id: number;
        window_id: string | null;
        last_session_id: string;
      }>;
    return rows.map((r) => ({
      userId: r.user_id,
      threadId: r.thread_id,
      windowId: r.window_id,
      lastSessionId: r.last_session_id
    }));
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
