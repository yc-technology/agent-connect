import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson } from "./utils.js";

export interface TrackedSessionData {
  session_id?: unknown;
  file_path?: unknown;
  last_byte_offset?: unknown;
}

export class TrackedSession {
  constructor(
    readonly sessionId: string,
    readonly filePath: string,
    public lastByteOffset = 0
  ) {}

  toDict(): { session_id: string; file_path: string; last_byte_offset: number } {
    return {
      session_id: this.sessionId,
      file_path: this.filePath,
      last_byte_offset: this.lastByteOffset
    };
  }

  static fromDict(data: TrackedSessionData): TrackedSession {
    return new TrackedSession(
      typeof data.session_id === "string" ? data.session_id : "",
      typeof data.file_path === "string" ? data.file_path : "",
      typeof data.last_byte_offset === "number" ? data.last_byte_offset : 0
    );
  }
}

export class MonitorState {
  trackedSessions: Record<string, TrackedSession> = {};
  private dirty = false;

  constructor(readonly stateFile: string) {}

  load(): void {
    if (!existsSync(this.stateFile)) return;

    try {
      const data = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown;
      if (!isRecord(data) || !isRecord(data.tracked_sessions)) {
        this.trackedSessions = {};
        return;
      }

      const sessions: Record<string, TrackedSession> = {};
      for (const [key, value] of Object.entries(data.tracked_sessions)) {
        if (isRecord(value)) {
          sessions[key] = TrackedSession.fromDict(value);
        }
      }
      this.trackedSessions = sessions;
    } catch {
      this.trackedSessions = {};
    }
  }

  async save(): Promise<void> {
    const trackedSessions: Record<string, ReturnType<TrackedSession["toDict"]>> = {};
    for (const [key, value] of Object.entries(this.trackedSessions)) {
      trackedSessions[key] = value.toDict();
    }

    await atomicWriteJson(this.stateFile, {
      tracked_sessions: trackedSessions
    });
    this.dirty = false;
  }

  getSession(sessionId: string): TrackedSession | null {
    return this.trackedSessions[sessionId] ?? null;
  }

  updateSession(session: TrackedSession): void {
    this.trackedSessions[session.sessionId] = session;
    this.dirty = true;
  }

  removeSession(sessionId: string): void {
    if (sessionId in this.trackedSessions) {
      delete this.trackedSessions[sessionId];
      this.dirty = true;
    }
  }

  async saveIfDirty(): Promise<void> {
    if (this.dirty) {
      await this.save();
    }
  }

  isDirty(): boolean {
    return this.dirty;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
