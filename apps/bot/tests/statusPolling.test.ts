import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetInteractiveState } from "../src/agent-connect/interactiveUi.js";
import { StatusPoller, updateStatusMessage } from "../src/agent-connect/statusPolling.js";
import type { TelegramApiLike } from "../src/agent-connect/messageSender.js";
import { installCaptureLogger } from "./helpers/testLogger.js";

const chrome =
  "──────────────────────────────────────\n" +
  "❯ \n" +
  "──────────────────────────────────────\n" +
  "  [Opus 4.6] Context: 50%\n";

function fakeApi(): TelegramApiLike {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    editMessageText: vi.fn(),
    deleteMessage: vi.fn()
  };
}

function deps(paneText: string) {
  const api = fakeApi();
  const messageQueue = {
    enqueueStatusUpdate: vi.fn(),
    drain: vi.fn(async () => undefined),
    getQueue: vi.fn(() => null),
    clearStatusMsgInfo: vi.fn(),
    clearToolMsgIdsForTopic: vi.fn(),
    clearLastAssistantMessageId: vi.fn()
  };
  return {
    api,
    routing: {
      resolveChatId: (userId: number) => userId
    },
    sessionManager: {
      iterThreadBindings: function* (): IterableIterator<[number, number, string]> {},
      getTopicProbeMessageId: vi.fn(() => null),
      unbindThread: vi.fn()
    },
    tmuxManager: {
      findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
      capturePane: vi.fn(async () => paneText),
      killWindow: vi.fn(async () => true)
    },
    messageQueue
  };
}

describe("status polling", () => {
  beforeEach(() => resetInteractiveState());

  it("enqueues parsed status lines", async () => {
    const testDeps = deps(`output\n✻ Reading file\n${chrome}`);

    await updateStatusMessage(testDeps, 100, "@5", 42);

    expect(testDeps.messageQueue.enqueueStatusUpdate).toHaveBeenCalledWith(100, "@5", "Reading file", 42);
    expect(testDeps.messageQueue.drain).toHaveBeenCalledWith(100);
  });

  it("clears completed status lines instead of sending them", async () => {
    const testDeps = deps(`output\n✻ Cooked for 3s\n${chrome}`);

    await updateStatusMessage(testDeps, 100, "@5", 42);

    expect(testDeps.messageQueue.enqueueStatusUpdate).toHaveBeenCalledWith(100, "@5", null, 42);
    expect(testDeps.messageQueue.drain).toHaveBeenCalledWith(100);
  });

  it("detects interactive UI and skips status enqueue", async () => {
    const testDeps = deps(
      " Select model\n" +
        " Switch between Claude models.\n\n" +
        "   1. Default\n" +
        " ❯ 2. Sonnet\n\n" +
        " Enter to confirm · Esc to exit\n"
    );

    await updateStatusMessage(testDeps, 100, "@5", 42);

    expect(testDeps.api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Select model"),
      expect.objectContaining({ message_thread_id: 42 })
    );
    expect(testDeps.messageQueue.enqueueStatusUpdate).not.toHaveBeenCalled();
  });

  it("clears status and binding for missing windows", async () => {
    const testDeps = deps("");
    testDeps.tmuxManager.findWindowById = vi.fn(async () => null) as never;
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001);

    await poller.tick();

    expect(testDeps.sessionManager.unbindThread).toHaveBeenCalledWith(100, 42);
    expect(testDeps.messageQueue.clearStatusMsgInfo).toHaveBeenCalledWith(100, 42);
    expect(testDeps.messageQueue.clearToolMsgIdsForTopic).toHaveBeenCalledWith(100, 42);
  });

  it("kills tmux window and clears state when a bound Telegram topic was deleted", async () => {
    const testDeps = deps("");
    testDeps.api.sendChatAction = vi.fn(async () => {
      throw new Error("Bad Request: message thread not found");
    });
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001, 0.001);

    await poller.tick();

    expect(testDeps.api.sendChatAction).toHaveBeenCalledWith(100, "typing", { message_thread_id: 42 });
    expect(testDeps.tmuxManager.killWindow).toHaveBeenCalledWith("@5");
    expect(testDeps.sessionManager.unbindThread).toHaveBeenCalledWith(100, 42);
    expect(testDeps.messageQueue.clearStatusMsgInfo).toHaveBeenCalledWith(100, 42);
    expect(testDeps.messageQueue.clearToolMsgIdsForTopic).toHaveBeenCalledWith(100, 42);
  });

  it("probes forum topics without requiring a stored message id", async () => {
    const testDeps = deps("");
    testDeps.api.sendChatAction = vi.fn();
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001, 0.001);

    await poller.tick();

    expect(testDeps.api.sendChatAction).toHaveBeenCalledWith(100, "typing", { message_thread_id: 42 });
  });

  it("logs non-deletion topic probe failures without clearing the binding", async () => {
    const log = installCaptureLogger();
    const testDeps = deps("");
    testDeps.api.sendChatAction = vi.fn(async () => {
      throw new Error("Bad Request: chat action failed");
    });
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001, 0.001);

    try {
      await poller.tick();

      expect(testDeps.tmuxManager.killWindow).not.toHaveBeenCalled();
      expect(testDeps.sessionManager.unbindThread).not.toHaveBeenCalled();
      const probeWarns = log.at("warn").filter((r) => r.msg.includes("topic probe failed"));
      expect(probeWarns.length).toBeGreaterThan(0);
      expect(probeWarns[0]).toMatchObject({ userId: 100, threadId: 42, windowId: "@5" });
      expect(String(probeWarns[0]!.err)).toContain("chat action failed");
    } finally {
      log.restore();
    }
  });

  it("ignores benign topic probe failures", async () => {
    const log = installCaptureLogger();
    const testDeps = deps("");
    testDeps.api.sendChatAction = vi.fn(async () => {
      throw new Error("Bad Request: REACTION_EMPTY");
    });
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001, 0.001);

    try {
      await poller.tick();

      expect(testDeps.tmuxManager.killWindow).not.toHaveBeenCalled();
      expect(testDeps.sessionManager.unbindThread).not.toHaveBeenCalled();
      expect(log.at("warn").filter((r) => r.msg.includes("topic probe"))).toEqual([]);
    } finally {
      log.restore();
    }
  });

  it("treats topic_closed as benign (user may reopen) — does not kill window", async () => {
    const log = installCaptureLogger();
    const testDeps = deps("");
    testDeps.api.sendChatAction = vi.fn(async () => {
      throw new Error("Bad Request: TOPIC_CLOSED");
    });
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001, 0.001);

    try {
      await poller.tick();

      expect(testDeps.tmuxManager.killWindow).not.toHaveBeenCalled();
      expect(testDeps.sessionManager.unbindThread).not.toHaveBeenCalled();
      expect(log.at("warn").filter((r) => r.msg.includes("topic probe"))).toEqual([]);
    } finally {
      log.restore();
    }
  });

  it("cleanup of missing window also drops registry row so FK CASCADE clears sessions", async () => {
    const testDeps = deps("");
    testDeps.tmuxManager.findWindowById = vi.fn(async () => null) as never;
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const deleteWindow = vi.fn();
    (testDeps as ReturnType<typeof deps> & { registry: { deleteWindow: typeof deleteWindow } }).registry = {
      deleteWindow
    };
    const poller = new StatusPoller(testDeps, 0.001);

    await poller.tick();

    expect(deleteWindow).toHaveBeenCalledWith("@5");
  });

  it("cleanup on topic delete also drops registry row", async () => {
    const testDeps = deps("");
    testDeps.api.sendChatAction = vi.fn(async () => {
      throw new Error("Bad Request: message thread not found");
    });
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const deleteWindow = vi.fn();
    (testDeps as ReturnType<typeof deps> & { registry: { deleteWindow: typeof deleteWindow } }).registry = {
      deleteWindow
    };
    const poller = new StatusPoller(testDeps, 0.001, 0.001);

    await poller.tick();

    expect(testDeps.tmuxManager.killWindow).toHaveBeenCalledWith("@5");
    expect(deleteWindow).toHaveBeenCalledWith("@5");
  });
});
