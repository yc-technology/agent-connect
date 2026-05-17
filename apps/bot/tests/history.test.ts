import { describe, expect, it, vi } from "vitest";
import {
  buildHistoryKeyboard,
  buildHistoryPage,
  parseHistoryCallbackData,
  sendHistory
} from "../src/agent-connect/history.js";
import type { HistoryMessage } from "../src/agent-connect/session.js";

const sessionManager = {
  getDisplayName: () => "project",
  getRecentMessages: vi.fn(async (): Promise<[HistoryMessage[], number]> => [
    [
      {
        role: "user" as const,
        text: "please fix",
        contentType: "text",
        timestamp: "2026-05-16T08:09:00.000Z"
      },
      {
        role: "assistant" as const,
        text: "fixed",
        contentType: "text",
        timestamp: "2026-05-16T08:10:00.000Z"
      }
    ],
    2
  ]),
  updateUserWindowOffset: vi.fn()
};

function callbackData(button: unknown): string | undefined {
  return (button as { callback_data?: string }).callback_data;
}

describe("history rendering", () => {
  it("renders messages with role and time markers", async () => {
    const page = await buildHistoryPage(sessionManager, { showUserMessages: true }, "@1");

    expect(page.text).toContain("📋 [project] Messages (2 total)");
    expect(page.text).toContain("───── 08:09 ─────");
    expect(page.text).toContain("👤 please fix");
    expect(page.text).toContain("fixed");
  });

  it("can hide user messages", async () => {
    const page = await buildHistoryPage(sessionManager, { showUserMessages: false }, "@1");

    expect(page.totalMessages).toBe(1);
    expect(page.text).not.toContain("please fix");
    expect(page.text).toContain("fixed");
  });

  it("builds pagination callback data with byte ranges", () => {
    const keyboard = buildHistoryKeyboard("@1", 0, 2, 10, 20);

    expect(keyboard?.inline_keyboard[0]?.map(callbackData)).toEqual([
      "noop",
      "hn:1:@1:10:20"
    ]);
  });

  it("parses history callback data", () => {
    expect(parseHistoryCallbackData("hn:2:@1:10:20")).toEqual({
      offset: 2,
      windowId: "@1",
      startByte: 10,
      endByte: 20
    });
    expect(parseHistoryCallbackData("bad")).toBeNull();
  });

  it("updates unread offset after sending unread history", async () => {
    const reply = vi.fn(async () => undefined);

    await sendHistory(
      { reply },
      sessionManager,
      { showUserMessages: true },
      "@1",
      { userId: 100, startByte: 1, endByte: 99 }
    );

    expect(reply).toHaveBeenCalled();
    expect(sessionManager.updateUserWindowOffset).toHaveBeenCalledWith(100, "@1", 99);
  });
});
