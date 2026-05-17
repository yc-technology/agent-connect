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

  it("edits an existing interactive UI message", async () => {
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

    expect(fake.messages).toHaveLength(1);
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
