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

  it("throttles consecutive status edits and resumes after cooldown", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      fake = fakeApi();
      const manager = queue();

      // Initial send establishes the message — no cooldown set yet.
      manager.enqueueStatusUpdate(100, "@1", "tick 1", 42);
      await manager.drain(100);
      expect(fake.messages).toEqual(["tick 1"]);

      // First edit goes through and starts the 1500ms cooldown.
      vi.setSystemTime(1_000_100);
      manager.enqueueStatusUpdate(100, "@1", "tick 2", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual(["tick 2"]);

      // ~500ms later — still inside cooldown, swallowed.
      vi.setSystemTime(1_000_600);
      manager.enqueueStatusUpdate(100, "@1", "tick 3", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual(["tick 2"]);

      // ~1300ms after the throttled edit started — still inside cooldown.
      vi.setSystemTime(1_001_400);
      manager.enqueueStatusUpdate(100, "@1", "tick 4", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual(["tick 2"]);

      // Past the cooldown — the next text actually edits through.
      vi.setSystemTime(1_001_700);
      manager.enqueueStatusUpdate(100, "@1", "tick 5", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual(["tick 2", "tick 5"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off status edits for the server-supplied retry_after on 429", async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    try {
      fake = fakeApi();
      // The 1st edit throws a grammY-style 429; subsequent calls succeed.
      let editCount = 0;
      const throwing429ThenOk: NonNullable<TelegramApiLike["editMessageText"]> = vi.fn(
        async (_chatId, _messageId, text) => {
          editCount += 1;
          if (editCount === 1) {
            // grammY GrammyError shape: { parameters: { retry_after: N } }
            const err = Object.assign(new Error("429: Too Many Requests: retry after 5"), {
              parameters: { retry_after: 5 }
            });
            throw err;
          }
          fake.edits.push(text);
        }
      );
      fake.editMessageText = throwing429ThenOk;
      const manager = queue();

      manager.enqueueStatusUpdate(100, "@1", "initial", 42);
      await manager.drain(100);
      expect(fake.messages).toEqual(["initial"]);

      // First edit hits 429 → 5s server-supplied backoff installed (+250ms cushion).
      vi.setSystemTime(2_000_100);
      manager.enqueueStatusUpdate(100, "@1", "second", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual([]); // edit threw, nothing landed

      // 3 seconds later — still inside the 5s backoff.
      vi.setSystemTime(2_003_500);
      manager.enqueueStatusUpdate(100, "@1", "third", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual([]);

      // ~5.5 seconds after the 429 → cooldown expired → next edit goes through.
      vi.setSystemTime(2_005_600);
      manager.enqueueStatusUpdate(100, "@1", "fourth", 42);
      await manager.drain(100);
      expect(fake.edits).toEqual(["fourth"]);
    } finally {
      vi.useRealTimers();
    }
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

  it("content send retries past a transient 429 and delivers the message", async () => {
    vi.useFakeTimers({ now: 3_000_000 });
    try {
      fake = fakeApi();
      let sendCount = 0;
      const flakeyThen429ThenOk: NonNullable<TelegramApiLike["sendMessage"]> = vi.fn(
        async (_chatId, text) => {
          sendCount += 1;
          if (sendCount === 1) {
            const err = Object.assign(new Error("429: Too Many Requests: retry after 1"), {
              parameters: { retry_after: 1 }
            });
            throw err;
          }
          fake.messages.push(text);
          return { message_id: sendCount };
        }
      );
      fake.sendMessage = flakeyThen429ThenOk;
      const manager = queue();

      manager.enqueueContentMessage(100, "@1", ["important answer"], { threadId: 42 });
      const drainP = manager.drain(100);
      // Let the first send attempt throw, then advance timers past the 1s
      // server-supplied backoff so the withRetryAfter wrapper retries.
      await vi.advanceTimersByTimeAsync(1500);
      await drainP;
      expect(sendCount).toBe(2);
      expect(fake.messages).toEqual(["important answer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("content send gives up after the retry budget is exhausted", async () => {
    vi.useFakeTimers({ now: 4_000_000 });
    try {
      fake = fakeApi();
      let sendCount = 0;
      const always429: NonNullable<TelegramApiLike["sendMessage"]> = vi.fn(async () => {
        sendCount += 1;
        const err = Object.assign(new Error("429"), { parameters: { retry_after: 1 } });
        throw err;
      });
      fake.sendMessage = always429;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const manager = queue();

      manager.enqueueContentMessage(100, "@1", ["doomed"], { threadId: 42 });
      const drainP = manager.drain(100);
      // Advance enough time for all retries to play out (3 sleeps of ~1.25s
      // between 4 attempts).
      await vi.advanceTimersByTimeAsync(10_000);
      await drainP;
      // 4 attempts: initial + 3 retries. After the 4th throw, withRetryAfter
      // gives up and re-throws; runDrainLoop catches + warns. Bounded — no
      // infinite loop.
      expect(sendCount).toBe(4);
      expect(fake.messages).toEqual([]);
      expect(warn).toHaveBeenCalledWith("[messageQueue task]", expect.any(Error));
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
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

  it("concurrent drains serialize — second await waits for ITS work, not just for the existing drain to no-op", async () => {
    fake = fakeApi();
    // 50ms-per-send slowdown so first drain is unambiguously still in flight
    // when the second drain is invoked.
    const slowApi: TelegramApiLike & typeof fake = {
      ...fake,
      sendMessage: vi.fn(async (_chatId, text) => {
        await new Promise((r) => setTimeout(r, 50));
        const id = (slowApi.messages.push(text), slowApi.messages.length);
        return { message_id: id };
      })
    } as never;
    const manager = queue(slowApi);

    manager.enqueueContentMessage(100, "@1", ["first"], {
      contentType: "text",
      role: "assistant",
      threadId: 42
    });
    const first = manager.drain(100);

    // Stop-event flow: a new assistant text is enqueued + drained while the
    // first send is still mid-flight.
    manager.enqueueContentMessage(100, "@1", ["second"], {
      contentType: "text",
      role: "assistant",
      threadId: 42
    });
    const second = manager.drain(100);

    await second;

    // CRITICAL: after `await second` resolves, lastAssistantMessageId must
    // reflect the SECOND send (msg 2). Pre-fix the second drain() returned
    // immediately due to the `processing` single-flight, so "second" was
    // still queued and msg 1 was still being sent — Stop's onTurnEnd would
    // then react on msg 1 (or null), never on msg 2.
    expect(manager.getLastAssistantMessageId(100, 42)).toBe(2);
    await first;
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
