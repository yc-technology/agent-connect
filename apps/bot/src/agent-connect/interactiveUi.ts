import {
  CB_ASK_DOWN,
  CB_ASK_ENTER,
  CB_ASK_ESC,
  CB_ASK_LEFT,
  CB_ASK_LITERAL_D,
  CB_ASK_LITERAL_N,
  CB_ASK_LITERAL_Y,
  CB_ASK_REFRESH,
  CB_ASK_RIGHT,
  CB_ASK_SPACE,
  CB_ASK_TAB,
  CB_ASK_UP
} from "./callbackData.js";
import { logger } from "./logger.js";
import { NO_LINK_PREVIEW, type TelegramApiLike } from "./messageSender.js";
import type { SessionRoutingLike } from "./messageQueue.js";
import { extractInteractiveContent, isInteractiveUi } from "./terminalParser.js";
import { threadOptions } from "./telegramThread.js";
import type { TmuxManager } from "./tmuxManager.js";
import { errorMessage } from "./utils.js";

// statusPolling retries handleInteractiveUi every 1s while a picker is visible
// AND interactiveModes is unset (i.e. while every send is failing). Without
// throttling, a persistent failure (e.g. chat closed, message_thread_id
// invalid) floods the log at 1 Hz per stuck window. Coalesce identical errors
// per (windowId, msg) so we see the first occurrence + roughly one heartbeat
// per minute, instead of 60 lines/min.
const INTERACTIVE_LOG_THROTTLE_MS = 60_000;
const interactiveLogLastAt = new Map<string, number>();

function shouldLogInteractiveFailure(windowId: string, kind: string, errMsg: string): boolean {
  const key = `${windowId}::${kind}::${errMsg}`;
  const now = Date.now();
  const last = interactiveLogLastAt.get(key) ?? 0;
  if (now - last < INTERACTIVE_LOG_THROTTLE_MS) return false;
  interactiveLogLastAt.set(key, now);
  return true;
}

export const INTERACTIVE_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode"]);

type InteractiveKey = `${number}:${number}`;

const interactiveMessages = new Map<InteractiveKey, number>();
const interactiveModes = new Map<InteractiveKey, string>();
// Last picker content shown per key. Lets handleInteractiveUi skip the
// editMessageText call when the pane hasn't changed — without this, a
// static picker would fire an editMessageText every status-poll tick
// (~2s) forever, each returning a 400 "not modified". With it, idle
// pickers cost nothing and only genuine content changes (e.g. Claude
// advancing from one AskUserQuestion straight to the next) hit the API.
const interactiveContents = new Map<InteractiveKey, string>();

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
  interactiveContents.clear();
}

export function buildInteractiveKeyboard(windowId: string, uiName = ""): InlineKeyboardMarkupLike {
  const button = (label: string, prefix: string) => ({
    text: label,
    callback_data: `${prefix}${windowId}`.slice(0, 64)
  });

  // SessionSurvey is the Claude data-usage prompt — three letter shortcuts
  // (y/n/d) instead of nav keys. The standard arrow/Enter keyboard would
  // just be confusing here, so render a dedicated 3-button row.
  if (uiName === "SessionSurvey") {
    return {
      inline_keyboard: [
        [
          button("✅ Yes", CB_ASK_LITERAL_Y),
          button("❌ No", CB_ASK_LITERAL_N),
          button("🚫 Don't ask again", CB_ASK_LITERAL_D)
        ]
      ]
    };
  }

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
  if (!content) {
    if (shouldLogInteractiveFailure(windowId, "extract-null", "")) {
      logger().warn(
        { userId, windowId, threadId },
        "interactiveUi: pane isInteractiveUi but extractInteractiveContent=null"
      );
    }
    return false;
  }

  const key = interactiveKey(userId, threadId);
  const chatId = deps.routing.resolveChatId(userId, threadId);
  const keyboard = buildInteractiveKeyboard(windowId, content.name);
  const options = withThread(threadId, {
    reply_markup: keyboard,
    link_preview_options: NO_LINK_PREVIEW
  });

  const existingMessageId = interactiveMessages.get(key);
  if (existingMessageId && deps.api.editMessageText) {
    // Content dedup: if the same picker text is already displayed in this
    // message, skip the edit entirely. statusPolling re-runs us every tick
    // while a picker is up (so consecutive AskUserQuestions refresh), and
    // without this guard a static picker would editMessageText every ~2s.
    if (interactiveContents.get(key) === content.content) {
      interactiveModes.set(key, windowId);
      return true;
    }
    try {
      await deps.api.editMessageText(chatId, existingMessageId, content.content, options);
      interactiveModes.set(key, windowId);
      interactiveContents.set(key, content.content);
      return true;
    } catch (error) {
      if (isMessageNotModified(error)) {
        // Telegram confirms the content is already what we wanted — record
        // it so the dedup above short-circuits subsequent ticks.
        interactiveModes.set(key, windowId);
        interactiveContents.set(key, content.content);
        return true;
      }
      const editErr = errorMessage(error);
      if (shouldLogInteractiveFailure(windowId, "edit-failed", editErr)) {
        logger().warn(
          {
            userId,
            windowId,
            threadId,
            chatId,
            existingMessageId,
            uiName: content.name,
            err: editErr
          },
          "interactiveUi: editMessageText failed (non-not-modified); falling back to sendMessage"
        );
      }
    }
  }

  try {
    const sent = await deps.api.sendMessage(chatId, content.content, options);
    if (!sent) {
      if (shouldLogInteractiveFailure(windowId, "send-falsy", "")) {
        logger().warn(
          {
            userId,
            windowId,
            threadId,
            chatId,
            contentLen: content.content.length,
            uiName: content.name
          },
          "interactiveUi: sendMessage returned falsy"
        );
      }
      return false;
    }
    interactiveMessages.set(key, sent.message_id);
    interactiveModes.set(key, windowId);
    interactiveContents.set(key, content.content);
    // Reset throttle state for this window so the next failure (if any) logs
    // immediately rather than being suppressed by a stale previous-error key.
    for (const k of interactiveLogLastAt.keys()) {
      if (k.startsWith(`${windowId}::`)) interactiveLogLastAt.delete(k);
    }
    logger().info(
      {
        userId,
        windowId,
        threadId,
        chatId,
        messageId: sent.message_id,
        uiName: content.name
      },
      "interactiveUi: picker forwarded to Telegram"
    );
    if (existingMessageId && deps.api.deleteMessage) {
      await deps.api.deleteMessage(chatId, existingMessageId).catch(() => undefined);
    }
    return true;
  } catch (error) {
    const sendErr = errorMessage(error);
    if (shouldLogInteractiveFailure(windowId, "send-threw", sendErr)) {
      logger().warn(
        {
          userId,
          windowId,
          threadId,
          chatId,
          contentLen: content.content.length,
          uiName: content.name,
          err: sendErr
        },
        "interactiveUi: sendMessage threw"
      );
    }
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
  interactiveContents.delete(key);
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
