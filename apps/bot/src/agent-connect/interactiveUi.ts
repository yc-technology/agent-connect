import {
  CB_ASK_DOWN,
  CB_ASK_ENTER,
  CB_ASK_ESC,
  CB_ASK_LEFT,
  CB_ASK_REFRESH,
  CB_ASK_RIGHT,
  CB_ASK_SPACE,
  CB_ASK_TAB,
  CB_ASK_UP
} from "./callbackData.js";
import { NO_LINK_PREVIEW, type TelegramApiLike } from "./messageSender.js";
import type { SessionRoutingLike } from "./messageQueue.js";
import { extractInteractiveContent, isInteractiveUi } from "./terminalParser.js";
import { threadOptions } from "./telegramThread.js";
import type { TmuxManager } from "./tmuxManager.js";

export const INTERACTIVE_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode"]);

type InteractiveKey = `${number}:${number}`;

const interactiveMessages = new Map<InteractiveKey, number>();
const interactiveModes = new Map<InteractiveKey, string>();

export interface InteractiveUiDeps {
  api: TelegramApiLike;
  routing: SessionRoutingLike;
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane">;
}

export interface InlineKeyboardMarkupLike {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export function getInteractiveWindow(userId: number, threadId: number | null = null): string | null {
  return interactiveModes.get(interactiveKey(userId, threadId)) ?? null;
}

export function setInteractiveMode(userId: number, windowId: string, threadId: number | null = null): void {
  interactiveModes.set(interactiveKey(userId, threadId), windowId);
}

export function clearInteractiveMode(userId: number, threadId: number | null = null): void {
  interactiveModes.delete(interactiveKey(userId, threadId));
}

export function getInteractiveMessageId(userId: number, threadId: number | null = null): number | null {
  return interactiveMessages.get(interactiveKey(userId, threadId)) ?? null;
}

export function resetInteractiveState(): void {
  interactiveMessages.clear();
  interactiveModes.clear();
}

export function buildInteractiveKeyboard(windowId: string, uiName = ""): InlineKeyboardMarkupLike {
  const button = (label: string, prefix: string) => ({
    text: label,
    callback_data: `${prefix}${windowId}`.slice(0, 64)
  });
  const verticalOnly = uiName === "RestoreCheckpoint";

  const rows: InlineKeyboardMarkupLike["inline_keyboard"] = [
    [
      button("␣ Space", CB_ASK_SPACE),
      button("↑", CB_ASK_UP),
      button("⇥ Tab", CB_ASK_TAB)
    ]
  ];

  if (verticalOnly) {
    rows.push([button("↓", CB_ASK_DOWN)]);
  } else {
    rows.push([
      button("←", CB_ASK_LEFT),
      button("↓", CB_ASK_DOWN),
      button("→", CB_ASK_RIGHT)
    ]);
  }

  rows.push([
    button("⎋ Esc", CB_ASK_ESC),
    button("🔄", CB_ASK_REFRESH),
    button("⏎ Enter", CB_ASK_ENTER)
  ]);

  return { inline_keyboard: rows };
}

export async function handleInteractiveUi(
  deps: InteractiveUiDeps,
  userId: number,
  windowId: string,
  threadId: number | null = null
): Promise<boolean> {
  const window = await deps.tmuxManager.findWindowById(windowId);
  if (!window) return false;

  const paneText = await deps.tmuxManager.capturePane(window.windowId);
  if (!paneText || !isInteractiveUi(paneText)) return false;

  const content = extractInteractiveContent(paneText);
  if (!content) return false;

  const key = interactiveKey(userId, threadId);
  const chatId = deps.routing.resolveChatId(userId, threadId);
  const keyboard = buildInteractiveKeyboard(windowId, content.name);
  const options = withThread(threadId, {
    reply_markup: keyboard,
    link_preview_options: NO_LINK_PREVIEW
  });

  const existingMessageId = interactiveMessages.get(key);
  if (existingMessageId && deps.api.editMessageText) {
    try {
      await deps.api.editMessageText(chatId, existingMessageId, content.content, options);
      interactiveModes.set(key, windowId);
      return true;
    } catch (error) {
      if (isMessageNotModified(error)) {
        interactiveModes.set(key, windowId);
        return true;
      }
    }
  }

  try {
    const sent = await deps.api.sendMessage(chatId, content.content, options);
    if (!sent) return false;
    interactiveMessages.set(key, sent.message_id);
    interactiveModes.set(key, windowId);
    if (existingMessageId && deps.api.deleteMessage) {
      await deps.api.deleteMessage(chatId, existingMessageId).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearInteractiveMessage(
  deps: Pick<InteractiveUiDeps, "api" | "routing"> | null,
  userId: number,
  threadId: number | null = null
): Promise<void> {
  const key = interactiveKey(userId, threadId);
  const messageId = interactiveMessages.get(key);
  interactiveMessages.delete(key);
  interactiveModes.delete(key);
  if (!deps || !messageId || !deps.api.deleteMessage) return;

  const chatId = deps.routing.resolveChatId(userId, threadId);
  await deps.api.deleteMessage(chatId, messageId).catch(() => undefined);
}

function interactiveKey(userId: number, threadId: number | null): InteractiveKey {
  return `${userId}:${threadId ?? 0}`;
}

function withThread(threadId: number | null, options: Record<string, unknown>): Record<string, unknown> {
  return { ...options, ...threadOptions(threadId) };
}

function isMessageNotModified(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Message is not modified");
}
