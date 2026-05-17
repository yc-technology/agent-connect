import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MonitorState, TrackedSession } from "../src/agent-connect/monitorState.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-connect-monitor-state-test-"));
}

describe("TrackedSession", () => {
  it("round trips through dict format", () => {
    const original = new TrackedSession("sess-1", "/tmp/test.jsonl", 42);
    const restored = TrackedSession.fromDict(original.toDict());
    expect(restored.sessionId).toBe("sess-1");
    expect(restored.filePath).toBe("/tmp/test.jsonl");
    expect(restored.lastByteOffset).toBe(42);
  });

  it("uses defaults for missing fields", () => {
    const session = TrackedSession.fromDict({});
    expect(session.sessionId).toBe("");
    expect(session.filePath).toBe("");
    expect(session.lastByteOffset).toBe(0);
  });
});

describe("MonitorState", () => {
  it("loads missing and corrupt files as empty state", () => {
    const dir = tmpDir();
    try {
      const missing = new MonitorState(join(dir, "missing.json"));
      missing.load();
      expect(missing.trackedSessions).toEqual({});

      const corruptPath = join(dir, "corrupt.json");
      writeFileSync(corruptPath, "{{{not json");
      const corrupt = new MonitorState(corruptPath);
      corrupt.load();
      expect(corrupt.trackedSessions).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads valid JSON", () => {
    const dir = tmpDir();
    try {
      const stateFile = join(dir, "state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          tracked_sessions: {
            s1: {
              session_id: "s1",
              file_path: "/a.jsonl",
              last_byte_offset: 100
            }
          }
        })
      );
      const state = new MonitorState(stateFile);
      state.load();
      expect(state.getSession("s1")?.lastByteOffset).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves and loads a round trip", async () => {
    const dir = tmpDir();
    try {
      const stateFile = join(dir, "state.json");
      const state = new MonitorState(stateFile);
      state.updateSession(new TrackedSession("ses-001", "/tmp/test.jsonl", 1024));
      await state.save();

      const loaded = new MonitorState(stateFile);
      loaded.load();
      expect(loaded.getSession("ses-001")).toMatchObject({
        sessionId: "ses-001",
        filePath: "/tmp/test.jsonl",
        lastByteOffset: 1024
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks dirty state and saveIfDirty", async () => {
    const dir = tmpDir();
    try {
      const stateFile = join(dir, "state.json");
      const state = new MonitorState(stateFile);
      await state.saveIfDirty();
      expect(existsSync(stateFile)).toBe(false);

      state.updateSession(new TrackedSession("s1", "/a.jsonl"));
      expect(state.isDirty()).toBe(true);
      await state.saveIfDirty();
      expect(existsSync(stateFile)).toBe(true);
      expect(state.isDirty()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes sessions and persists the change", async () => {
    const dir = tmpDir();
    try {
      const stateFile = join(dir, "state.json");
      const state = new MonitorState(stateFile);
      state.updateSession(new TrackedSession("keep", "/tmp/keep.jsonl"));
      state.updateSession(new TrackedSession("drop", "/tmp/drop.jsonl"));
      await state.save();

      state.removeSession("drop");
      await state.save();

      const reloaded = new MonitorState(stateFile);
      reloaded.load();
      expect(reloaded.getSession("keep")).not.toBeNull();
      expect(reloaded.getSession("drop")).toBeNull();
      expect(Object.keys(reloaded.trackedSessions)).toHaveLength(1);

      const raw = JSON.parse(readFileSync(stateFile, "utf8")) as {
        tracked_sessions: Record<string, unknown>;
      };
      expect(raw.tracked_sessions.keep).toBeDefined();
      expect(raw.tracked_sessions.drop).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
