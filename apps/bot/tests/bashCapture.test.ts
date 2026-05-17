import { describe, expect, it, vi } from "vitest";
import { BashCaptureManager, runBashCaptureTask } from "../src/agent-connect/bashCapture.js";
import type { TelegramApiLike } from "../src/agent-connect/messageSender.js";

function fakeApi(): TelegramApiLike {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 10 })),
    editMessageText: vi.fn(),
    deleteMessage: vi.fn()
  };
}

describe("bash capture", () => {
  it("sends the first captured output and edits changed output", async () => {
    const api = fakeApi();
    const panes = [
      "context\n! echo hi\nhello\n",
      "context\n! echo hi\nhello\nworld\n"
    ];
    const tmuxManager = {
      capturePane: vi.fn(async () => panes.shift() ?? panes.at(-1) ?? "")
    };

    await runBashCaptureTask(
      {
        api,
        routing: { resolveChatId: () => 100 },
        tmuxManager
      },
      { userId: 1, threadId: 42, windowId: "@5", command: "echo hi" },
      { initialDelayMs: 0, pollDelayMs: 0, maxAttempts: 2 }
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("echo hi"),
      expect.objectContaining({ message_thread_id: 42, entities: expect.any(Array) })
    );
    expect(api.editMessageText).toHaveBeenCalledWith(
      100,
      10,
      expect.stringContaining("world"),
      expect.objectContaining({ message_thread_id: 42, entities: expect.any(Array) })
    );
  });

  it("does not send message_thread_id for private chat captures", async () => {
    const api = fakeApi();
    const tmuxManager = {
      capturePane: vi.fn(async () => "context\n! echo hi\nhello\n")
    };

    await runBashCaptureTask(
      {
        api,
        routing: { resolveChatId: () => 12345 },
        tmuxManager
      },
      { userId: 1, threadId: 0, windowId: "@5", command: "echo hi" },
      { initialDelayMs: 0, pollDelayMs: 0, maxAttempts: 1 }
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("echo hi"),
      expect.not.objectContaining({ message_thread_id: expect.anything() })
    );
  });

  it("cancels an existing capture for the same topic before starting a new one", async () => {
    const api = fakeApi();
    const tmuxManager = {
      capturePane: vi.fn(async () => "context\n! first\nold\n")
    };
    const manager = new BashCaptureManager(
      {
        api,
        routing: { resolveChatId: () => 100 },
        tmuxManager
      },
      { initialDelayMs: 1000, pollDelayMs: 1000, maxAttempts: 1 }
    );

    manager.start(1, 42, "@5", "first");
    manager.start(1, 42, "@5", "second");
    manager.cancelAll();

    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
