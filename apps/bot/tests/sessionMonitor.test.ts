import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TrackedSession } from "../src/agent-connect/monitorState.js";
import { SessionMonitor } from "../src/agent-connect/sessionMonitor.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-connect-session-monitor-test-"));
}

function entry(content: string) {
  return {
    type: "assistant",
    message: { content },
    sessionId: "test-session-id",
    cwd: "/tmp/test",
    timestamp: "2026-05-16T00:00:00.000Z"
  };
}

function monitor(dir: string): SessionMonitor {
  return new SessionMonitor({
    projectsPath: join(dir, "projects"),
    stateFile: join(dir, "monitor_state.json")
  });
}

describe("SessionMonitor.readNewLines", () => {
  it("recovers from a mid-line offset", async () => {
    const dir = tmpDir();
    try {
      const jsonlFile = join(dir, "session.jsonl");
      const entry1 = entry("first message");
      const entry2 = entry("second message");
      const line1 = JSON.stringify(entry1);
      writeFileSync(jsonlFile, `${line1}\n${JSON.stringify(entry2)}\n`, "utf8");

      const session = new TrackedSession(
        "test-session",
        jsonlFile,
        Math.floor(Buffer.byteLength(line1, "utf8") / 2)
      );
      const result = await monitor(dir).readNewLines(session, jsonlFile);

      expect(result).toEqual([]);
      expect(session.lastByteOffset).toBe(Buffer.byteLength(line1, "utf8") + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads normally from a valid offset", async () => {
    const dir = tmpDir();
    try {
      const jsonlFile = join(dir, "session.jsonl");
      const entry1 = entry("first");
      const entry2 = entry("second");
      writeFileSync(jsonlFile, `${JSON.stringify(entry1)}\n${JSON.stringify(entry2)}\n`, "utf8");

      const session = new TrackedSession("test-session", jsonlFile, 0);
      const result = await monitor(dir).readNewLines(session, jsonlFile);

      expect(result).toHaveLength(2);
      expect(session.lastByteOffset).toBe(statSync(jsonlFile).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resets offset when the file was truncated", async () => {
    const dir = tmpDir();
    try {
      const jsonlFile = join(dir, "session.jsonl");
      const onlyEntry = entry("content");
      writeFileSync(jsonlFile, `${JSON.stringify(onlyEntry)}\n`, "utf8");

      const session = new TrackedSession("test-session", jsonlFile, 9999);
      const result = await monitor(dir).readNewLines(session, jsonlFile);

      expect(result).toHaveLength(1);
      expect(session.lastByteOffset).toBe(statSync(jsonlFile).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not advance past a partial JSONL line", async () => {
    const dir = tmpDir();
    try {
      const jsonlFile = join(dir, "session.jsonl");
      const valid = entry("content");
      const validLine = JSON.stringify(valid);
      writeFileSync(jsonlFile, `${validLine}\n{"type": "assistant"`, "utf8");

      const session = new TrackedSession("test-session", jsonlFile, 0);
      const result = await monitor(dir).readNewLines(session, jsonlFile);

      expect(result).toHaveLength(1);
      expect(session.lastByteOffset).toBe(Buffer.byteLength(validLine, "utf8") + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionMonitor session_map handling", () => {
  it("loads only entries for the configured tmux session", async () => {
    const dir = tmpDir();
    try {
      const sessionMapFile = join(dir, "session_map.json");
      writeFileSync(
        sessionMapFile,
        JSON.stringify({
          "agent-connect:@1": { session_id: "s1" },
          "other:@2": { session_id: "s2" },
          "agent-connect:@3": {}
        }),
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile,
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2
        }
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({ "@1": "s1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters session_map to Telegram-bound windows when a binding provider is configured", async () => {
    const dir = tmpDir();
    try {
      const sessionMapFile = join(dir, "session_map.json");
      writeFileSync(
        sessionMapFile,
        JSON.stringify({
          "agent-connect:@1": { session_id: "bound-session" },
          "agent-connect:@2": { session_id: "local-session" }
        }),
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile,
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2
        },
        boundWindowIds: () => ["@1"]
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({ "@1": "bound-session" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps active Codex windows to latest sessions by cwd", async () => {
    const dir = tmpDir();
    try {
      const cwd = join(dir, "project");
      mkdirSync(cwd, { recursive: true });
      const codexHomePath = join(dir, "codex");
      const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
      mkdirSync(sessionDir, { recursive: true });
      const sessionId = "019e3004-fe4c-7cc1-88a5-4d253ac1cf93";
      writeFileSync(
        join(sessionDir, `rollout-2026-05-17T00-00-00-${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, cwd }
        })}\n${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex" }]
          }
        })}\n`,
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile: join(dir, "session_map.json"),
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2,
          agentType: "codex",
          codexHomePath
        },
        tmuxManager: {
          listWindows: vi.fn(async () => [
            {
              windowId: "@9",
              windowName: "project",
              cwd,
              paneCurrentCommand: "codex"
            }
          ])
        }
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({ "@9": sessionId });
      const messages = await sessionMonitor.checkForUpdates({ "@9": sessionId });
      expect(messages).toEqual([]);
      writeFileSync(
        join(sessionDir, `rollout-2026-05-17T00-00-00-${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, cwd }
        })}\n${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex" }]
          }
        })}\n${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "second message" }]
          }
        })}\n`,
        "utf8"
      );

      const nextMessages = await sessionMonitor.checkForUpdates({ "@9": sessionId });
      expect(nextMessages).toMatchObject([
        {
          sessionId,
          windowId: "@9",
          text: "second message",
          contentType: "text",
          role: "assistant"
        }
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses Codex hook session_map before cwd fallback", async () => {
    const dir = tmpDir();
    try {
      const cwd = join(dir, "project");
      mkdirSync(cwd, { recursive: true });
      const codexHomePath = join(dir, "codex");
      const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
      mkdirSync(sessionDir, { recursive: true });
      const firstSession = "019e3004-fe4c-7cc1-88a5-4d253ac1cf93";
      const secondSession = "019e31a7-4a6c-7182-acb3-5e99b129ad9a";
      for (const sessionId of [firstSession, secondSession]) {
        writeFileSync(
          join(sessionDir, `rollout-2026-05-17T00-00-00-${sessionId}.jsonl`),
          `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`,
          "utf8"
        );
      }
      const sessionMapFile = join(dir, "session_map.json");
      writeFileSync(
        sessionMapFile,
        JSON.stringify({
          "agent-connect:@1": { session_id: firstSession, cwd, window_name: "one" },
          "agent-connect:@2": { session_id: secondSession, cwd, window_name: "two" }
        }),
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile,
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2,
          agentType: "codex",
          codexHomePath
        },
        tmuxManager: {
          listWindows: vi.fn(async () => [
            { windowId: "@1", windowName: "one", cwd, paneCurrentCommand: "codex" },
            { windowId: "@2", windowName: "two", cwd, paneCurrentCommand: "codex" }
          ])
        }
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({
        "@1": firstSession,
        "@2": secondSession
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not monitor unbound Codex windows even when their hook is present", async () => {
    const dir = tmpDir();
    try {
      const cwd = join(dir, "project");
      mkdirSync(cwd, { recursive: true });
      const codexHomePath = join(dir, "codex");
      const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
      mkdirSync(sessionDir, { recursive: true });
      const boundSession = "019e3004-fe4c-7cc1-88a5-4d253ac1cf93";
      const localSession = "019e31a7-4a6c-7182-acb3-5e99b129ad9a";
      for (const sessionId of [boundSession, localSession]) {
        writeFileSync(
          join(sessionDir, `rollout-2026-05-17T00-00-00-${sessionId}.jsonl`),
          `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`,
          "utf8"
        );
      }
      const sessionMapFile = join(dir, "session_map.json");
      writeFileSync(
        sessionMapFile,
        JSON.stringify({
          "agent-connect:@1": { session_id: boundSession, cwd, window_name: "bound" },
          "agent-connect:@2": { session_id: localSession, cwd, window_name: "local" }
        }),
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile,
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2,
          agentType: "codex",
          codexHomePath
        },
        tmuxManager: {
          listWindows: vi.fn(async () => [
            { windowId: "@1", windowName: "bound", cwd, paneCurrentCommand: "codex" },
            { windowId: "@2", windowName: "local", cwd, paneCurrentCommand: "codex" }
          ])
        },
        boundWindowIds: () => ["@1"]
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({
        "@1": boundSession
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not use Codex cwd fallback for Telegram-bound windows", async () => {
    const dir = tmpDir();
    try {
      const cwd = join(dir, "project");
      mkdirSync(cwd, { recursive: true });
      const codexHomePath = join(dir, "codex");
      const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
      mkdirSync(sessionDir, { recursive: true });
      const localSession = "019e31a7-4a6c-7182-acb3-5e99b129ad9a";
      writeFileSync(
        join(sessionDir, `rollout-2026-05-17T00-00-00-${localSession}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id: localSession, cwd } })}\n`,
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile: join(dir, "session_map.json"),
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2,
          agentType: "codex",
          codexHomePath
        },
        tmuxManager: {
          listWindows: vi.fn(async () => [
            { windowId: "@1", windowName: "bound", cwd, paneCurrentCommand: "codex" }
          ])
        },
        boundWindowIds: () => ["@1"]
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses Codex hook session_map even when the session is outside the recent scan window", async () => {
    const dir = tmpDir();
    try {
      const cwd = join(dir, "project");
      mkdirSync(cwd, { recursive: true });
      const codexHomePath = join(dir, "codex");
      const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
      mkdirSync(sessionDir, { recursive: true });
      const hookedSession = "019e3004-fe4c-7cc1-88a5-4d253ac1cf93";
      const oldFile = join(sessionDir, `rollout-2026-05-17T00-00-00-${hookedSession}.jsonl`);
      writeFileSync(
        oldFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: hookedSession, cwd } })}\n`,
        "utf8"
      );
      const oldTime = new Date("2026-01-01T00:00:00.000Z");
      utimesSync(oldFile, oldTime, oldTime);

      for (let index = 0; index < 501; index += 1) {
        const decoySession = `decoy-session-${index}`;
        const decoyFile = join(sessionDir, `rollout-2026-05-17T00-00-${String(index).padStart(3, "0")}-${decoySession}.jsonl`);
        writeFileSync(
          decoyFile,
          `${JSON.stringify({ type: "session_meta", payload: { id: decoySession, cwd } })}\n`,
          "utf8"
        );
        const decoyTime = new Date(1770000000000 + index * 1000);
        utimesSync(decoyFile, decoyTime, decoyTime);
      }

      const sessionMapFile = join(dir, "session_map.json");
      writeFileSync(
        sessionMapFile,
        JSON.stringify({
          "agent-connect:@1": { session_id: hookedSession, cwd, window_name: "one" }
        }),
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile,
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2,
          agentType: "codex",
          codexHomePath
        },
        tmuxManager: {
          listWindows: vi.fn(async () => [
            { windowId: "@1", windowName: "one", cwd, paneCurrentCommand: "codex" },
            { windowId: "@2", windowName: "two", cwd, paneCurrentCommand: "codex" }
          ])
        }
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({
        "@1": hookedSession
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not guess Codex sessions for multiple windows in the same cwd", async () => {
    const dir = tmpDir();
    try {
      const cwd = join(dir, "project");
      mkdirSync(cwd, { recursive: true });
      const codexHomePath = join(dir, "codex");
      const sessionDir = join(codexHomePath, "sessions", "2026", "05", "17");
      mkdirSync(sessionDir, { recursive: true });
      const sessionId = "019e3004-fe4c-7cc1-88a5-4d253ac1cf93";
      writeFileSync(
        join(sessionDir, `rollout-2026-05-17T00-00-00-${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`,
        "utf8"
      );

      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        config: {
          sessionMapFile: join(dir, "session_map.json"),
          tmuxSessionName: "agent-connect",
          showUserMessages: true,
          monitorPollInterval: 2,
          agentType: "codex",
          codexHomePath
        },
        tmuxManager: {
          listWindows: vi.fn(async () => [
            { windowId: "@1", windowName: "one", cwd, paneCurrentCommand: "codex" },
            { windowId: "@2", windowName: "two", cwd, paneCurrentCommand: "codex" }
          ])
        }
      });

      await expect(sessionMonitor.loadCurrentSessionMap()).resolves.toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionMonitor loop behavior", () => {
  it("does not start another tick while the previous tick is still running", async () => {
    const dir = tmpDir();
    try {
      const sessionMonitor = new SessionMonitor({
        projectsPath: join(dir, "projects"),
        stateFile: join(dir, "monitor_state.json"),
        pollInterval: 0.001
      });
      let releaseTick!: () => void;
      let tickStarted!: () => void;
      const tickStartedPromise = new Promise<void>((resolve) => {
        tickStarted = resolve;
      });
      const tickReleasePromise = new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
      const tick = vi.fn(async () => {
        tickStarted();
        await tickReleasePromise;
      });
      (sessionMonitor as unknown as { tick: () => Promise<void> }).tick = tick;

      sessionMonitor.start();
      await tickStartedPromise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(tick).toHaveBeenCalledTimes(1);

      const stopped = sessionMonitor.stop();
      releaseTick();
      await stopped;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps ticking when a message callback throws", async () => {
    const dir = tmpDir();
    try {
      const sessionMonitor = monitor(dir);
      const callback = vi.fn(async () => {
        throw new Error("delivery failed");
      });
      sessionMonitor.setMessageCallback(callback);
      (sessionMonitor as unknown as { detectAndCleanupChanges: () => Promise<Record<string, string>> })
        .detectAndCleanupChanges = async () => ({ "@1": "s1" });
      (sessionMonitor as unknown as { checkForUpdates: () => Promise<unknown[]> }).checkForUpdates = async () => [
        {
          sessionId: "s1",
          text: "hello",
          isComplete: true,
          contentType: "text",
          role: "assistant",
          toolUseId: null,
          toolName: null,
          imageData: null
        }
      ];

      await expect(sessionMonitor.tick()).resolves.toBeUndefined();
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
