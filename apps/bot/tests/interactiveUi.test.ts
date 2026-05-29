import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildInteractiveKeyboard,
  clearInteractiveMessage,
  getInteractiveMessageId,
  getInteractiveWindow,
  handleInteractiveUi,
  resetInteractiveState
} from "../src/agent-connect/interactiveUi.js";
import type { TelegramApiLike } from "../src/agent-connect/messageSender.js";

function fakeApi(): TelegramApiLike & {
  messages: string[];
  edits: string[];
  deletes: number[];
} {
  return {
    messages: [],
    edits: [],
    deletes: [],
    sendMessage: vi.fn(async (_chatId, text) => {
      fake.messages.push(text);
      return { message_id: fake.messages.length };
    }),
    editMessageText: vi.fn(async (_chatId, _messageId, text) => {
      fake.edits.push(text);
    }),
    deleteMessage: vi.fn(async (_chatId, messageId) => {
      fake.deletes.push(messageId);
    })
  };
}

let fake = fakeApi();

const routing = {
  resolveChatId: (userId: number, threadId?: number | null) => (threadId ? -100000 - threadId : userId)
};

const settingsPane =
  " Select model\n" +
  " Switch between Claude models.\n\n" +
  "   1. Default\n" +
  " ❯ 2. Sonnet\n\n" +
  " Enter to confirm · Esc to exit\n";

describe("interactive UI", () => {
  beforeEach(() => {
    resetInteractiveState();
    fake = fakeApi();
  });

  it("builds full and vertical-only keyboards", () => {
    const settings = buildInteractiveKeyboard("@5", "Settings");
    const restore = buildInteractiveKeyboard("@5", "RestoreCheckpoint");

    expect(settings.inline_keyboard.flat().map((button) => button.callback_data)).toContain("aq:left:@5");
    expect(settings.inline_keyboard.flat().map((button) => button.callback_data)).toContain("aq:right:@5");
    expect(restore.inline_keyboard.flat().map((button) => button.callback_data)).not.toContain("aq:left:@5");
    expect(restore.inline_keyboard.flat().map((button) => button.callback_data)).toContain("aq:down:@5");
  });

  it("builds a dedicated y/n/d keyboard for SessionSurvey", () => {
    const survey = buildInteractiveKeyboard("@5", "SessionSurvey");
    const callbacks = survey.inline_keyboard.flat().map((button) => button.callback_data);
    // Three letter shortcuts, no nav keys — pressing ↑/↓/Enter in the
    // survey context would either be ignored or misinterpreted.
    expect(callbacks).toEqual(["aq:lit-y:@5", "aq:lit-n:@5", "aq:lit-d:@5"]);
    const labels = survey.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain("✅ Yes");
    expect(labels).toContain("❌ No");
    expect(labels).toContain("🚫 Don't ask again");
  });

  it("sends an interactive UI message and tracks mode", async () => {
    const handled = await handleInteractiveUi(
      {
        api: fake,
        routing,
        tmuxManager: {
          findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
          capturePane: vi.fn(async () => settingsPane)
        }
      },
      100,
      "@5",
      42
    );

    expect(handled).toBe(true);
    expect(fake.messages[0]).toContain("Select model");
    expect(getInteractiveWindow(100, 42)).toBe("@5");
    expect(getInteractiveMessageId(100, 42)).toBe(1);
  });

  it("content-dedups: identical pane on a second call does NOT re-edit", async () => {
    // statusPolling re-runs handleInteractiveUi every tick while a picker
    // is up. A static picker must not fire editMessageText every ~2s.
    const deps = {
      api: fake,
      routing,
      tmuxManager: {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(async () => settingsPane)
      }
    };

    await handleInteractiveUi(deps, 100, "@5", 42);
    await handleInteractiveUi(deps, 100, "@5", 42);

    expect(fake.messages).toHaveLength(1); // sent once
    expect(fake.edits).toHaveLength(0); // second call deduped, no edit
  });

  it("edits in place when the pane content changes (consecutive pickers)", async () => {
    // The bug this fixes: Claude advancing from one AskUserQuestion
    // straight to the next (no idle gap) must update the SAME Telegram
    // message with the new question, not leave it stuck on the old one.
    let pane = settingsPane;
    const deps = {
      api: fake,
      routing,
      tmuxManager: {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(async () => pane)
      }
    };

    await handleInteractiveUi(deps, 100, "@5", 42);
    expect(fake.messages).toHaveLength(1);

    // Claude moves to the next question — different picker content.
    pane =
      " ☐ next question\n" +
      "\n" +
      "Which option now?\n" +
      "❯ 1. Alpha\n" +
      "  2. Beta\n" +
      "Enter to select · ↑/↓ to navigate · Esc to cancel\n";
    await handleInteractiveUi(deps, 100, "@5", 42);

    expect(fake.messages).toHaveLength(1); // still the same message
    expect(fake.edits).toHaveLength(1); // edited in place with new content
    expect(fake.edits[0]).toContain("next question");
  });

  it("re-edits when the window changes even if picker text is identical (keyboard routes to new window)", async () => {
    // The inline keyboard's callback_data embeds the windowId. If a topic
    // rebinds to a different window showing byte-identical picker text, the
    // content-only dedup would skip the edit and leave buttons routing
    // keypresses to the OLD (dead) window. Window must be part of the guard.
    let windowId = "@5";
    const deps = {
      api: fake,
      routing,
      tmuxManager: {
        findWindowById: vi.fn(async (id: string) => ({ windowId: id, windowName: "p", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(async () => settingsPane) // identical text both times
      }
    };

    await handleInteractiveUi(deps, 100, windowId, 42);
    expect(fake.messages).toHaveLength(1);
    expect(fake.edits).toHaveLength(0);

    windowId = "@9"; // topic rebound to a new window, same picker text
    await handleInteractiveUi(deps, 100, windowId, 42);
    // Must re-edit (not dedup-skip) so the keyboard's callback_data points at @9.
    expect(fake.edits).toHaveLength(1);
  });

  it("clears and deletes the tracked interactive message", async () => {
    await handleInteractiveUi(
      {
        api: fake,
        routing,
        tmuxManager: {
          findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
          capturePane: vi.fn(async () => settingsPane)
        }
      },
      100,
      "@5",
      42
    );

    await clearInteractiveMessage({ api: fake, routing }, 100, 42);

    expect(fake.deletes).toEqual([1]);
    expect(getInteractiveWindow(100, 42)).toBeNull();
    expect(getInteractiveMessageId(100, 42)).toBeNull();
  });
});
