import { InputFile, type Bot } from "grammy";
import { logger } from "./logger.js";
import {
  convertMarkdownToTelegramEntities,
  stripSentinels,
  type TelegramEntityFormattedText
} from "./markdownV2.js";
import type { ToolResultImage } from "./transcriptParser.js";

export { stripSentinels } from "./markdownV2.js";

export const NO_LINK_PREVIEW = { is_disabled: true };

export interface TelegramMessage {
  message_id: number;
}

export interface TelegramApiLike {
  sendMessage(
    chatId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<TelegramMessage | null>;
  editMessageText?(
    chatId: number,
    messageId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  deleteMessage?(chatId: number, messageId: number): Promise<unknown>;
  sendPhoto?(
    chatId: number,
    photo: Buffer,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  sendMediaGroup?(
    chatId: number,
    media: Array<{ type: "photo"; media: Buffer }>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  sendChatAction?(chatId: number, action: string, options?: Record<string, unknown>): Promise<unknown>;
  setMessageReaction?(chatId: number, messageId: number, reaction: unknown[]): Promise<unknown>;
}

export interface ReplyTargetLike {
  reply(text: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface EditTextTargetLike {
  editMessageText(text: string, options?: Record<string, unknown>): Promise<unknown>;
}

export function telegramApiFromGrammy(bot: Pick<Bot, "api">): TelegramApiLike {
  return {
    sendMessage: async (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
    editMessageText: async (chatId, messageId, text, options) =>
      bot.api.editMessageText(chatId, messageId, text, options),
    deleteMessage: async (chatId, messageId) => bot.api.deleteMessage(chatId, messageId),
    sendPhoto: async (chatId, photo, options) =>
      bot.api.sendPhoto(chatId, new InputFile(photo, "photo.png"), options),
    sendMediaGroup: async (chatId, media, options) =>
      bot.api.sendMediaGroup(
        chatId,
        media.map((item, index) => ({
          type: "photo",
          media: new InputFile(item.media, `photo-${index + 1}.png`)
        })),
        options
      ),
    sendChatAction: async (chatId, action, options) => bot.api.sendChatAction(chatId, action as never, options),
    setMessageReaction: async (chatId, messageId, reaction) =>
      bot.api.setMessageReaction(chatId, messageId, reaction as never[])
  };
}

export function ensureEntityFormatted(text: string): TelegramEntityFormattedText {
  return convertMarkdownToTelegramEntities(text);
}

export function withNoLinkPreview(options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    link_preview_options: NO_LINK_PREVIEW,
    ...options
  };
}

export function plainOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
  const { entities: _entities, ...rest } = options;
  return rest;
}

function entityOptions(
  text: string,
  options: Record<string, unknown> = {}
): { text: string; options: Record<string, unknown> } {
  const formatted = ensureEntityFormatted(text);
  return {
    text: formatted.text,
    options: withNoLinkPreview({
      ...plainOptions(options),
      entities: formatted.entities
    })
  };
}

export async function sendWithFallback(
  api: TelegramApiLike,
  chatId: number,
  text: string,
  options: Record<string, unknown> = {}
): Promise<TelegramMessage | null> {
  try {
    const formatted = entityOptions(text, options);
    return await api.sendMessage(chatId, formatted.text, formatted.options);
  } catch (error) {
    if (isRetryAfter(error)) throw error;
    logFormatFallback("sendMessage entities", error);
    try {
      return await api.sendMessage(chatId, stripSentinels(text), plainOptions(withNoLinkPreview(options)));
    } catch (fallbackError) {
      if (isRetryAfter(fallbackError)) throw fallbackError;
      return null;
    }
  }
}

export async function replyWithFallback(
  target: ReplyTargetLike,
  text: string,
  options: Record<string, unknown> = {}
): Promise<unknown | null> {
  try {
    const formatted = entityOptions(text, options);
    return await target.reply(formatted.text, formatted.options);
  } catch (error) {
    if (isRetryAfter(error)) throw error;
    logFormatFallback("reply entities", error);
    try {
      return await target.reply(stripSentinels(text), plainOptions(withNoLinkPreview(options)));
    } catch (fallbackError) {
      if (isRetryAfter(fallbackError)) throw fallbackError;
      return null;
    }
  }
}

export async function editWithFallback(
  api: TelegramApiLike,
  chatId: number,
  messageId: number,
  text: string,
  options: Record<string, unknown> = {}
): Promise<boolean> {
  if (!api.editMessageText) return false;

  try {
    const formatted = entityOptions(text, options);
    await api.editMessageText(chatId, messageId, formatted.text, formatted.options);
    return true;
  } catch (error) {
    if (isRetryAfter(error)) throw error;
    logFormatFallback("editMessageText entities", error);
    try {
      await api.editMessageText(chatId, messageId, stripSentinels(text), plainOptions(withNoLinkPreview(options)));
      return true;
    } catch (fallbackError) {
      if (isRetryAfter(fallbackError)) throw fallbackError;
      return false;
    }
  }
}

export async function editTextWithFallback(
  target: EditTextTargetLike,
  text: string,
  options: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const formatted = entityOptions(text, options);
    await target.editMessageText(formatted.text, formatted.options);
    return true;
  } catch (error) {
    if (isRetryAfter(error)) throw error;
    logFormatFallback("editMessageText entities", error);
    try {
      await target.editMessageText(stripSentinels(text), plainOptions(withNoLinkPreview(options)));
      return true;
    } catch (fallbackError) {
      if (isRetryAfter(fallbackError)) throw fallbackError;
      return false;
    }
  }
}

export async function sendPhoto(
  api: TelegramApiLike,
  chatId: number,
  imageData: ToolResultImage[],
  options: Record<string, unknown> = {}
): Promise<void> {
  if (imageData.length === 0) return;

  try {
    if (imageData.length === 1) {
      await api.sendPhoto?.(chatId, imageData[0]!.data, options);
      return;
    }

    await api.sendMediaGroup?.(
      chatId,
      imageData.map((image) => ({ type: "photo" as const, media: image.data })),
      options
    );
  } catch (error) {
    if (isRetryAfter(error)) throw error;
  }
}

export function isRetryAfter(error: unknown): boolean {
  return retryAfterSeconds(error) !== null;
}

/**
 * Extract the server-supplied retry-after value (seconds) from a Telegram 429.
 * Recognized shapes:
 *   - `{ retry_after: 25 }` / `{ retryAfter: 25 }` (legacy direct fields)
 *   - `{ parameters: { retry_after: 25 } }` (grammY GrammyError shape)
 * Returns null if the error is not a recognized rate-limit error.
 */
export function retryAfterSeconds(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as Record<string, unknown>;
  const direct = e.retry_after ?? e.retryAfter;
  if (typeof direct === "number") return direct;
  const params = e.parameters;
  if (typeof params === "object" && params !== null) {
    const p = params as Record<string, unknown>;
    const fromParams = p.retry_after ?? p.retryAfter;
    if (typeof fromParams === "number") return fromParams;
  }
  return null;
}

function logFormatFallback(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger().warn({ operation, err: message }, "telegram formatted send failed; trying plain fallback");
}
