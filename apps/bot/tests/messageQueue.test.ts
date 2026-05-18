import { describe, expect, it, vi } from "vitest";
import { canMergeTasks, MessageQueueManager, type MessageTask } from "../src/agent-connect/messageQueue.js";
import type { TelegramApiLike } from "../src/agent-connect/messageSender.js";

function task(overrides: Partial<MessageTask> = {}): MessageTask {
  return {
    taskType: "content",
    windowId: "@1",
    parts: ["hello"],
    contentType: "text",
    ...overrides
  };
}

function fakeApi(): TelegramApiLike & {
  messages: string[];
  edits: string[];
  deletes: number[];
  photos: Buffer[];
} {
  let nextId = 1;
  return {
    messages: [],
    edits: [],
    deletes: [],
    photos: [],
    sendMessage: vi.fn(async (_chatId, text) => {
      const id = nextId++;
      fake.messages.push(text);
      return { message_id: id };
    }),
    editMessageText: vi.fn(async (_chatId, _messageId, text) => {
      fake.edits.push(text);
    }),
    deleteMessage: vi.fn(async (_chatId, messageId) => {
      fake.deletes.push(messageId);
    }),
    sendPhoto: vi.fn(async (_chatId, photo) => {
      fake.photos.push(photo);
    }),
    sendMediaGroup: vi.fn(),
    sendChatAction: vi.fn()
  };
}

let fake = fakeApi();

function queue(
  api = fake,
  routing: Partial<{ setTopicProbeMessageId(userId: number, threadId: number, messageId: number): void }> = {}
) {
  return new MessageQueueManager(api, {
    resolveChatId: (userId, threadId) => (threadId ? -100000 - threadId : userId),
    ...routing
  });
}

describe("message queue merging", () => {
  it("allows ordinary content merge", () => {
    expect(canMergeTasks(task(), task({ parts: ["world"] }))).toBe(true);
  });

  it("does not merge different windows or tool messages", () => {
    expect(canMergeTasks(task(), task({ windowId: "@2" }))).toBe(false);
    expect(canMergeTasks(task({ contentType: "tool_use" }), task())).toBe(false);
    expect(canMergeTasks(task(), task({ contentType: "tool_result" }))).toBe(false);
  });

  it("does not merge different roles or content types", () => {
    expect(canMergeTasks(task({ role: "user" }), task({ role: "assistant" }))).toBe(false);
    expect(canMergeTasks(task({ contentType: "text" }), task({ contentType: "thinking" }))).toBe(false);
  });

  it("merges consecutive content tasks on drain", async () => {
    fake = fakeApi();
    const manager = queue();
    manager.enqueueContentMessage(100, "@1", ["one"]);
    manager.enqueueContentMessage(100, "@1", ["two"]);
    manager.enqueueContentMessage(100, "@1", ["three"]);

    await manager.drain(100);

    expect(fake.messages).toEqual(["one", "two", "three"]);
    expect(fake.sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe("message queue status handling", () => {
  it("sends, edits, and clears status messages", async () => {
    fake = fakeApi();
    const manager = queue();

    manager.enqueueStatusUpdate(100, "@1", "working", 42);
    await manager.drain(100);
    expect(fake.messages).toEqual(["working"]);
    expect(manager.getStatusMessageInfo(100, 42)).toMatchObject({ messageId: 1, windowId: "@1" });

    manager.enqueueStatusUpdate(100, "@1", "still working", 42);
    await manager.drain(100);
    expect(fake.edits).toEqual(["still working"]);
    expect(manager.getStatusMessageInfo(100, 42)?.text).toBe("still working");

    manager.enqueueStatusUpdate(100, "@1", null, 42);
    await manager.drain(100);
    expect(fake.deletes).toEqual([1]);
    expect(manager.getStatusMessageInfo(100, 42)).toBeNull();
  });

  it("converts status message to first content message", async () => {
    fake = fakeApi();
    const manager = queue();

    manager.enqueueStatusUpdate(100, "@1", "working", 42);
    await manager.drain(100);
    manager.enqueueContentMessage(100, "@1", ["final answer"], { threadId: 42 });
    await manager.drain(100);

    expect(fake.edits).toEqual(["final answer"]);
    expect(fake.messages).toEqual(["working"]);
  });

  it("deletes status before content when a clear task is queued first", async () => {
    fake = fakeApi();
    const manager = queue();

    manager.enqueueStatusUpdate(100, "@1", "Thinking...", 42);
    await manager.drain(100);
    manager.enqueueStatusUpdate(100, "@1", null, 42);
    manager.enqueueContentMessage(100, "@1", ["final answer"], { threadId: 42 });
    await manager.drain(100);

    expect(fake.deletes).toEqual([1]);
    expect(fake.edits).toEqual([]);
    expect(fake.messages).toEqual(["Thinking...", "final answer"]);
  });

  it("records sent topic message ids for deletion probes", async () => {
    fake = fakeApi();
    const setTopicProbeMessageId = vi.fn();
    const manager = queue(fake, { setTopicProbeMessageId });

    manager.enqueueStatusUpdate(100, "@1", "working", 42);
    await manager.drain(100);
    manager.enqueueContentMessage(100, "@1", ["final answer"], { threadId: 42 });
    await manager.drain(100);

    expect(setTopicProbeMessageId).toHaveBeenCalledWith(100, 42, 1);
  });
});

describe("message queue tool handling", () => {
  it("records tool_use message id and edits it with tool_result", async () => {
    fake = fakeApi();
    const manager = queue();

    manager.enqueueContentMessage(100, "@1", ["**Read**(a.ts)"], {
      contentType: "tool_use",
      toolUseId: "t1",
      threadId: 42
    });
    await manager.drain(100);
    expect(manager.getToolMessageId("t1", 100, 42)).toBe(1);

    manager.enqueueContentMessage(100, "@1", ["**Read**(a.ts)\n  ⎿  Read 3 lines"], {
      contentType: "tool_result",
      toolUseId: "t1",
      threadId: 42
    });
    await manager.drain(100);

    expect(fake.edits).toEqual(["Read(a.ts)\n⎿  Read 3 lines"]);
    expect(manager.getToolMessageId("t1", 100, 42)).toBeNull();
  });

  it("sends images attached to content", async () => {
    fake = fakeApi();
    const manager = queue();
    manager.enqueueContentMessage(100, "@1", ["image result"], {
      imageData: [{ mediaType: "image/png", data: Buffer.from("png") }]
    });

    await manager.drain(100);

    expect(fake.messages).toEqual(["image result"]);
    expect(fake.photos).toEqual([Buffer.from("png")]);
  });

  it("clears tool ids for a topic", async () => {
    fake = fakeApi();
    const manager = queue();
    manager.enqueueContentMessage(100, "@1", ["tool"], {
      contentType: "tool_use",
      toolUseId: "t1",
      threadId: 42
    });
    await manager.drain(100);

    manager.clearToolMsgIdsForTopic(100, 42);
    expect(manager.getToolMessageId("t1", 100, 42)).toBeNull();
  });
});

describe("message queue last assistant message id", () => {
  it("records id only on assistant text sends", async () => {
    fake = fakeApi();
    const manager = queue();
    manager.enqueueContentMessage(100, "@1", ["thought"], {
      contentType: "thinking",
      role: "assistant",
      threadId: 42
    });
    manager.enqueueContentMessage(100, "@1", ["tool call"], {
      contentType: "tool_use",
      toolUseId: "t1",
      role: "assistant",
      threadId: 42
    });
    await manager.drain(100);
    expect(manager.getLastAssistantMessageId(100, 42)).toBeNull();

    manager.enqueueContentMessage(100, "@1", ["final reply"], {
      contentType: "text",
      role: "assistant",
      threadId: 42
    });
    await manager.drain(100);
    expect(manager.getLastAssistantMessageId(100, 42)).not.toBeNull();
  });

  it("tracks the LAST chunk id for multi-part assistant text", async () => {
    fake = fakeApi();
    const manager = queue();
    manager.enqueueContentMessage(100, "@1", ["part 1", "part 2", "part 3"], {
      contentType: "text",
      role: "assistant",
      threadId: 42
    });
    await manager.drain(100);
    // Three sends produce ids 1, 2, 3 (per fakeApi's auto-incrementing id).
    expect(manager.getLastAssistantMessageId(100, 42)).toBe(3);
  });

  it("clearLastAssistantMessageId is per-topic", async () => {
    fake = fakeApi();
    const manager = queue();
    manager.enqueueContentMessage(100, "@1", ["reply"], {
      contentType: "text",
      role: "assistant",
      threadId: 42
    });
    await manager.drain(100);
    expect(manager.getLastAssistantMessageId(100, 42)).not.toBeNull();
    manager.clearLastAssistantMessageId(100, 99);
    expect(manager.getLastAssistantMessageId(100, 42)).not.toBeNull();
    manager.clearLastAssistantMessageId(100, 42);
    expect(manager.getLastAssistantMessageId(100, 42)).toBeNull();
  });
});
