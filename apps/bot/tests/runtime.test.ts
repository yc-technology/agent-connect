import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleNewMessage } from "../src/agent-connect/runtime.js";
import type { NewMessage } from "../src/agent-connect/sessionMonitor.js";

function baseMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    sessionId: "s1",
    text: "hello",
    isComplete: true,
    contentType: "text",
    role: "assistant",
    toolUseId: null,
    toolName: null,
    imageData: null,
    ...overrides
  };
}

describe("handleNewMessage", () => {
  it("routes complete messages through the queue and updates offsets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-runtime-test-"));
    try {
      const filePath = join(dir, "session.jsonl");
      writeFileSync(filePath, "line\n", "utf8");
      const enqueueContentMessage = vi.fn();
      const enqueueStatusUpdate = vi.fn();
      const drain = vi.fn(async () => undefined);
      const updateUserWindowOffset = vi.fn();

      await handleNewMessage(baseMessage({ windowId: "@1" }), {
        config: { showToolCalls: true, showUserMessages: false },
        sessionManager: {
          findUsersForWindow: vi.fn(() => [[100, "@1", 42] satisfies [number, string, number]]),
          resolveSessionForWindow: vi.fn(async () => ({
            sessionId: "s1",
            summary: "summary",
            messageCount: 1,
            filePath
          })),
          updateUserWindowOffset
        },
        messageQueue: { enqueueContentMessage, enqueueStatusUpdate, drain }
      });

      expect(enqueueContentMessage).toHaveBeenCalledWith(
        100,
        "@1",
        ["hello"],
        expect.objectContaining({ threadId: 42, contentType: "text" })
      );
      expect(drain).toHaveBeenCalledWith(100);
      expect(updateUserWindowOffset).toHaveBeenCalledWith(100, "@1", 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collapses intermediate notifications to a temporary thinking status when disabled", async () => {
    const enqueueContentMessage = vi.fn();
    const enqueueStatusUpdate = vi.fn();
    const drain = vi.fn();
    await handleNewMessage(baseMessage({ contentType: "tool_use", toolUseId: "t1", windowId: "@1" }), {
      config: { showToolCalls: false, showUserMessages: false },
      sessionManager: {
        findUsersForWindow: vi.fn(() => [[100, "@1", 42] satisfies [number, string, number]]),
        resolveSessionForWindow: vi.fn(),
        updateUserWindowOffset: vi.fn()
      },
      messageQueue: { enqueueContentMessage, enqueueStatusUpdate, drain }
    });

    expect(enqueueContentMessage).not.toHaveBeenCalled();
    expect(enqueueStatusUpdate).toHaveBeenCalledWith(100, "@1", "Thinking...", 42);
    expect(drain).toHaveBeenCalledWith(100);
  });

  it("clears the temporary thinking status before final assistant text", async () => {
    const enqueueContentMessage = vi.fn();
    const enqueueStatusUpdate = vi.fn();
    const drain = vi.fn();

    await handleNewMessage(baseMessage({ contentType: "text", windowId: "@1" }), {
      config: { showToolCalls: false, showUserMessages: false },
      sessionManager: {
        findUsersForWindow: vi.fn(() => [[100, "@1", 42] satisfies [number, string, number]]),
        resolveSessionForWindow: vi.fn(),
        updateUserWindowOffset: vi.fn()
      },
      messageQueue: { enqueueContentMessage, enqueueStatusUpdate, drain }
    });

    expect(enqueueStatusUpdate).toHaveBeenCalledWith(100, "@1", null, 42);
    expect(enqueueContentMessage).toHaveBeenCalledWith(
      100,
      "@1",
      ["hello"],
      expect.objectContaining({ threadId: 42, contentType: "text" })
    );
  });

  it("does nothing without a monitored window id", async () => {
    const enqueueContentMessage = vi.fn();
    await handleNewMessage(baseMessage(), {
      config: { showToolCalls: true, showUserMessages: false },
      sessionManager: {
        findUsersForWindow: vi.fn(),
        resolveSessionForWindow: vi.fn(),
        updateUserWindowOffset: vi.fn()
      },
      messageQueue: { enqueueContentMessage, enqueueStatusUpdate: vi.fn(), drain: vi.fn() }
    });

    expect(enqueueContentMessage).not.toHaveBeenCalled();
  });

  it("skips live user prompts when disabled", async () => {
    const enqueueContentMessage = vi.fn();
    const findUsersForWindow = vi.fn();

    await handleNewMessage(baseMessage({ role: "user", windowId: "@1" }), {
      config: { showToolCalls: true, showUserMessages: false },
      sessionManager: {
        findUsersForWindow,
        resolveSessionForWindow: vi.fn(),
        updateUserWindowOffset: vi.fn()
      },
      messageQueue: { enqueueContentMessage, enqueueStatusUpdate: vi.fn(), drain: vi.fn() }
    });

    expect(findUsersForWindow).not.toHaveBeenCalled();
    expect(enqueueContentMessage).not.toHaveBeenCalled();
  });

  it("routes messages by window id when the monitor provides one", async () => {
    const enqueueContentMessage = vi.fn();
    const findUsersForWindow = vi.fn(() => [[100, "@9", 7] satisfies [number, string, number]]);

    await handleNewMessage(baseMessage({ windowId: "@9" }), {
      config: { showToolCalls: true, showUserMessages: false },
      sessionManager: {
        findUsersForWindow,
        resolveSessionForWindow: vi.fn(),
        updateUserWindowOffset: vi.fn()
      },
      messageQueue: { enqueueContentMessage, enqueueStatusUpdate: vi.fn(), drain: vi.fn() }
    });

    expect(findUsersForWindow).toHaveBeenCalledWith("@9");
    expect(enqueueContentMessage).toHaveBeenCalledWith(
      100,
      "@9",
      ["hello"],
      expect.objectContaining({ threadId: 7 })
    );
  });
});
