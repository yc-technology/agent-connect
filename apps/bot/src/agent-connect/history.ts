import { InlineKeyboard } from "grammy";
import { CB_HISTORY_NEXT, CB_HISTORY_PREV } from "./callbackData.js";
import { replyWithFallback } from "./messageSender.js";
import type { HistoryMessage, SessionManager } from "./session.js";
import { splitMessage } from "./telegramSender.js";
import { EXPANDABLE_QUOTE_END, EXPANDABLE_QUOTE_START } from "./transcriptParser.js";

export interface HistorySessionLike {
  getDisplayName(windowId: string): string;
  getRecentMessages(
    windowId: string,
    options?: { startByte?: number; endByte?: number | null }
  ): Promise<[HistoryMessage[], number]>;
  updateUserWindowOffset?(userId: number, windowId: string, offset: number): void;
  resolveChatId?(userId: number, threadId?: number | null): number;
}

export interface HistoryConfigLike {
  showUserMessages: boolean;
}

export interface HistoryPageOptions {
  offset?: number;
  startByte?: number;
  endByte?: number;
}

export interface HistoryPage {
  text: string;
  keyboard: InlineKeyboard | null;
  pageIndex: number;
  totalPages: number;
  totalMessages: number;
}

export interface HistoryCallbackData {
  offset: number;
  windowId: string;
  startByte: number;
  endByte: number;
}

export function parseHistoryCallbackData(data: string): HistoryCallbackData | null {
  if (!data.startsWith(CB_HISTORY_PREV) && !data.startsWith(CB_HISTORY_NEXT)) {
    return null;
  }

  const rest = data.slice(CB_HISTORY_PREV.length);
  try {
    const parts = rest.split(":");
    if (parts.length < 4) {
      const [offsetRaw, windowId] = rest.split(":", 2);
      if (!offsetRaw || !windowId) return null;
      const offset = Number.parseInt(offsetRaw, 10);
      if (!Number.isFinite(offset)) return null;
      return {
        offset,
        windowId,
        startByte: 0,
        endByte: 0
      };
    }

    const offset = Number.parseInt(parts[0] ?? "", 10);
    const startByte = Number.parseInt(parts.at(-2) ?? "", 10);
    const endByte = Number.parseInt(parts.at(-1) ?? "", 10);
    const windowId = parts.slice(1, -2).join(":");
    if (!Number.isFinite(offset) || !Number.isFinite(startByte) || !Number.isFinite(endByte) || !windowId) {
      return null;
    }
    return { offset, windowId, startByte, endByte };
  } catch {
    return null;
  }
}

export async function buildHistoryPage(
  sessionManager: HistorySessionLike,
  config: HistoryConfigLike,
  windowId: string,
  options: HistoryPageOptions = {}
): Promise<HistoryPage> {
  const displayName = sessionManager.getDisplayName(windowId);
  const startByte = options.startByte ?? 0;
  const endByte = options.endByte ?? 0;
  const isUnread = startByte > 0 || endByte > 0;
  const [rawMessages] = await sessionManager.getRecentMessages(windowId, {
    startByte,
    endByte: endByte > 0 ? endByte : null
  });

  const messages = config.showUserMessages
    ? rawMessages
    : rawMessages.filter((message) => message.role === "assistant");

  if (messages.length === 0) {
    return {
      text: isUnread ? `📬 [${displayName}] No unread messages.` : `📋 [${displayName}] No messages yet.`,
      keyboard: null,
      pageIndex: 0,
      totalPages: 1,
      totalMessages: 0
    };
  }

  const header = isUnread
    ? `📬 [${displayName}] ${messages.length} unread messages`
    : `📋 [${displayName}] Messages (${messages.length} total)`;
  const fullText = [header, ...messages.flatMap(formatHistoryMessage)].join("\n\n");
  const pages = splitMessage(fullText, 4096);
  const requestedOffset = options.offset ?? -1;
  const pageIndex =
    requestedOffset < 0
      ? pages.length - 1
      : Math.max(0, Math.min(requestedOffset, pages.length - 1));

  return {
    text: pages[pageIndex] ?? "",
    keyboard: buildHistoryKeyboard(windowId, pageIndex, pages.length, startByte, endByte),
    pageIndex,
    totalPages: pages.length,
    totalMessages: messages.length
  };
}

export function buildHistoryKeyboard(
  windowId: string,
  pageIndex: number,
  totalPages: number,
  startByte = 0,
  endByte = 0
): InlineKeyboard | null {
  if (totalPages <= 1) return null;
  const row: Array<ReturnType<typeof InlineKeyboard.text>> = [];

  if (pageIndex > 0) {
    row.push(
      InlineKeyboard.text(
        "◀ Older",
        `${CB_HISTORY_PREV}${pageIndex - 1}:${windowId}:${startByte}:${endByte}`.slice(0, 64)
      )
    );
  }

  row.push(InlineKeyboard.text(`${pageIndex + 1}/${totalPages}`, "noop"));

  if (pageIndex < totalPages - 1) {
    row.push(
      InlineKeyboard.text(
        "Newer ▶",
        `${CB_HISTORY_NEXT}${pageIndex + 1}:${windowId}:${startByte}:${endByte}`.slice(0, 64)
      )
    );
  }

  return new InlineKeyboard([row]);
}

export async function sendHistory(
  target: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  sessionManager: Pick<SessionManager, "getDisplayName" | "getRecentMessages" | "updateUserWindowOffset">,
  config: HistoryConfigLike,
  windowId: string,
  options: HistoryPageOptions & { userId?: number; messageThreadId?: number | null } = {}
): Promise<void> {
  const page = await buildHistoryPage(sessionManager, config, windowId, options);
  await replyWithFallback(target, page.text, page.keyboard ? { reply_markup: page.keyboard } : undefined);

  const endByte = options.endByte ?? 0;
  if ((options.startByte ?? 0) > 0 && options.userId !== undefined && endByte > 0) {
    sessionManager.updateUserWindowOffset(options.userId, windowId, endByte);
  }
}

function formatHistoryMessage(message: HistoryMessage): string[] {
  const lines: string[] = [];
  const hhmm = formatTimestamp(message.timestamp);
  lines.push(hhmm ? `───── ${hhmm} ─────` : "─────────────");

  const text = stripExpandableSentinels(message.text);
  if (message.role === "user") {
    lines.push(`👤 ${text}`);
  } else if (message.contentType === "thinking") {
    lines.push(`∴ Thinking…\n${text}`);
  } else {
    lines.push(text);
  }
  return lines;
}

function formatTimestamp(timestamp?: string | null): string {
  if (!timestamp) return "";
  const marker = timestamp.includes("T") ? timestamp.split("T")[1] : timestamp;
  return marker?.slice(0, 5) ?? "";
}

function stripExpandableSentinels(text: string): string {
  return text.replaceAll(EXPANDABLE_QUOTE_START, "").replaceAll(EXPANDABLE_QUOTE_END, "");
}
