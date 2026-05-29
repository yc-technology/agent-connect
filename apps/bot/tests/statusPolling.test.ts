import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetInteractiveState } from "../src/agent-connect/interactiveUi.js";
import { StatusPoller, updateStatusMessage } from "../src/agent-connect/statusPolling.js";
import type { TelegramApiLike } from "../src/agent-connect/messageSender.js";
import type { ListWindowsResult } from "../src/agent-connect/tmuxManager.js";
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

const FAKE_WINDOW = { windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" };

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
      unbindThread: vi.fn(),
      markBindingForRecovery: vi.fn()
    },
    tmuxManager: {
      findWindowById: vi.fn(async () => FAKE_WINDOW),
      listWindowsAuthoritative: vi.fn<() => Promise<ListWindowsResult>>(async () => ({
        ok: true,
        windows: [FAKE_WINDOW]
      })),
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

    await updateStatusMessage(testDeps, 100, FAKE_WINDOW, 42);

    expect(testDeps.messageQueue.enqueueStatusUpdate).toHaveBeenCalledWith(100, "@5", "Reading file", 42);
    expect(testDeps.messageQueue.drain).toHaveBeenCalledWith(100);
  });

  it("clears completed status lines instead of sending them", async () => {
    const testDeps = deps(`output\n✻ Cooked for 3s\n${chrome}`);

    await updateStatusMessage(testDeps, 100, FAKE_WINDOW, 42);

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

    await updateStatusMessage(testDeps, 100, FAKE_WINDOW, 42);

    expect(testDeps.api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Select model"),
      expect.objectContaining({ message_thread_id: 42 })
    );
    expect(testDeps.messageQueue.enqueueStatusUpdate).not.toHaveBeenCalled();
  });

  it("updateStatusMessage does not re-resolve window via findWindowById", async () => {
    // Plan A correctness: tick provides an already-resolved TmuxWindow, so
    // updateStatusMessage must NOT call findWindowById again — that would
    // double the tmux exec rate per binding (the fork-storm that took down
    // the tmux server on 2026-05-21).
    const testDeps = deps(`output\n✻ Reading file\n${chrome}`);
    await updateStatusMessage(testDeps, 100, FAKE_WINDOW, 42);
    expect(testDeps.tmuxManager.findWindowById).not.toHaveBeenCalled();
  });

  it("soft-cleans a binding when its window is authoritatively missing from tmux", async () => {
    // Plan-A soft delete: when tmux is reachable but the specific window_id
    // isn't in the inventory, we route to markBindingForRecovery (NOT
    // unbindThread). The binding row survives so last_session_id is available
    // to the resume picker on the next /join.
    const testDeps = deps("");
    testDeps.tmuxManager.listWindowsAuthoritative = vi.fn(async () => ({
      ok: true as const,
      windows: [] // tmux reachable, but @5 is gone
    }));
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
    };
    const poller = new StatusPoller(testDeps, 0.001);

    await poller.tick();

    expect(testDeps.sessionManager.markBindingForRecovery).toHaveBeenCalledWith(100, 42);
    expect(testDeps.sessionManager.unbindThread).not.toHaveBeenCalled();
    expect(testDeps.messageQueue.clearStatusMsgInfo).toHaveBeenCalledWith(100, 42);
    expect(testDeps.messageQueue.clearToolMsgIdsForTopic).toHaveBeenCalledWith(100, 42);
  });

  it("notifies Telegram on tmux outage recovery (down→up edge with recoverable bindings)", async () => {
    // Stage 2a: when listWindowsAuthoritative transitions from {ok:false} to
    // {ok:true}, surface a heads-up to every thread that has a last_session_id
    // anchor — they can /join to restore. Fresh boots ({ok:true} from the
    // first tick) MUST NOT trigger this; codex specifically flagged that as
    // a flip-flop hazard with cleanup.
    const testDeps = deps("");
    const listMock = testDeps.tmuxManager.listWindowsAuthoritative;
    (listMock as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, reason: "tmux-unreachable", detail: "down" })
      .mockResolvedValueOnce({ ok: true, windows: [] });
    const listRecoverableBindings = vi.fn(() => [
      { userId: 100, threadId: 42, windowId: "@5", lastSessionId: "sess-xyz" }
    ]);
    (testDeps as ReturnType<typeof deps> & {
      registry: { deleteWindow: ReturnType<typeof vi.fn>; listRecoverableBindings: typeof listRecoverableBindings };
    }).registry = {
      deleteWindow: vi.fn(),
      listRecoverableBindings
    };
    const poller = new StatusPoller(testDeps, 0.001);

    // tick 1: tmux down → state becomes "down", no notify
    await poller.tick();
    expect(testDeps.api.sendMessage).not.toHaveBeenCalled();

    // tick 2: tmux up → down→up edge → notify
    await poller.tick();
    // The notify is a floating promise; poll until it flushes instead of
    // waiting a single setImmediate (which races on slow CI — the
    // "setTimeout and hope" anti-pattern per CLAUDE.md).
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      (testDeps.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length === 0
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(testDeps.api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringMatching(/tmux server was restarted/),
      expect.objectContaining({ message_thread_id: 42 })
    );
  });

  it("does NOT notify on a fresh-boot {ok:true} when no previous outage was seen", async () => {
    const testDeps = deps("");
    testDeps.tmuxManager.listWindowsAuthoritative = vi.fn(async () => ({
      ok: true as const,
      windows: []
    }));
    const listRecoverableBindings = vi.fn(() => [
      { userId: 100, threadId: 42, windowId: "@5", lastSessionId: "sess-xyz" }
    ]);
    (testDeps as ReturnType<typeof deps> & {
      registry: { deleteWindow: ReturnType<typeof vi.fn>; listRecoverableBindings: typeof listRecoverableBindings };
    }).registry = {
      deleteWindow: vi.fn(),
      listRecoverableBindings
    };
    const poller = new StatusPoller(testDeps, 0.001);

    await poller.tick();
    await new Promise((r) => setImmediate(r));
    expect(testDeps.api.sendMessage).not.toHaveBeenCalled();
    expect(listRecoverableBindings).not.toHaveBeenCalled();
  });

  it("does NOT clean up bindings when tmux is unreachable", async () => {
    // The regression we're locking: previously listWindows returned [] on any
    // tmux failure (including server-dead), tick treated that as "every window
    // is gone", and cleanupTopicBinding ran for every row → FK CASCADE wiped
    // sessions / thread_bindings / user_window_offsets. Bot DB was empty after
    // one tick. Now: unreachable tmux → tick is a no-op, bindings preserved.
    const log = installCaptureLogger();
    const testDeps = deps("");
    testDeps.tmuxManager.listWindowsAuthoritative = vi.fn(async () => ({
      ok: false as const,
      reason: "tmux-unreachable" as const,
      detail: "no server running on /tmp/tmux-501/default"
    }));
    testDeps.sessionManager.iterThreadBindings = function* () {
      yield [100, 42, "@5"] satisfies [number, number, string];
      yield [100, 43, "@7"] satisfies [number, number, string];
    };
    const deleteWindow = vi.fn();
    (testDeps as ReturnType<typeof deps> & { registry: { deleteWindow: typeof deleteWindow } }).registry = {
      deleteWindow
    };
    const poller = new StatusPoller(testDeps, 0.001);

    try {
      await poller.tick();

      expect(testDeps.sessionManager.unbindThread).not.toHaveBeenCalled();
      expect(deleteWindow).not.toHaveBeenCalled();
      expect(testDeps.messageQueue.clearStatusMsgInfo).not.toHaveBeenCalled();
      expect(testDeps.tmuxManager.capturePane).not.toHaveBeenCalled();
      const warns = log.at("warn").filter((r) => r.msg.includes("tmux server unreachable"));
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatchObject({ reason: "tmux-unreachable" });
    } finally {
      log.restore();
    }
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
    testDeps.tmuxManager.listWindowsAuthoritative = vi.fn(async () => ({
      ok: true as const,
      windows: [] // tmux up, but @5 is genuinely gone
    }));
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
