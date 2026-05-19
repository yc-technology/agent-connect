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
    // `_filename` is an internal channel field (underscore-prefixed to mark
    // it as not part of Telegram's wire shape). The grammY adapter reads
    // it to set the InputFile filename per item; downstream Telegram
    // sniffs bytes for actual format detection.
    // `caption` belongs only on the FIRST item per Telegram's group
    // caption semantics; the caller is responsible for placement.
    media: Array<{ type: "photo"; media: Buffer; _filename?: string; caption?: string }>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  /**
   * Used as a fallback when sendPhoto fails (e.g. PHOTO_INVALID_DIMENSIONS
   * for too-tall screenshots, or > 10 MB / dimension limits). Document
   * uploads bypass the photo compressor: max 50 MB, no dimension cap,
   * original quality preserved. Filename should come via `options.filename`
   * so Telegram + the receiver get a sensible extension.
   */
  sendDocument?(
    chatId: number,
    document: Buffer,
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

/**
 * Pop `filename` out of an options bag (returning it separately from the
 * rest) so the grammY adapter can hand it to `InputFile` without leaking
 * the internal channel field back into the wire payload.
 */
function popFilename(
  opts: Record<string, unknown> | undefined,
  fallback: string
): { filename: string; rest: Record<string, unknown> } {
  if (!opts) return { filename: fallback, rest: {} };
  const { filename: f, ...rest } = opts;
  return {
    filename: typeof f === "string" && f.length > 0 ? f : fallback,
    rest
  };
}

export function telegramApiFromGrammy(bot: Pick<Bot, "api">): TelegramApiLike {
  return {
    sendMessage: async (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
    editMessageText: async (chatId, messageId, text, options) =>
      bot.api.editMessageText(chatId, messageId, text, options),
    deleteMessage: async (chatId, messageId) => bot.api.deleteMessage(chatId, messageId),
    sendPhoto: async (chatId, photo, options) => {
      const { filename, rest } = popFilename(options, "photo.png");
      return bot.api.sendPhoto(chatId, new InputFile(photo, filename), rest);
    },
    sendMediaGroup: async (chatId, media, options) => {
      // Per-item filename comes via `_filename` (now typed on the
      // TelegramApiLike.sendMediaGroup item shape, so no cast needed).
      const items = media.map((item, index) => {
        const fname =
          typeof item._filename === "string" && item._filename.length > 0
            ? item._filename
            : `photo-${index + 1}.png`;
        const wire: { type: "photo"; media: InputFile; caption?: string } = {
          type: "photo",
          media: new InputFile(item.media, fname)
        };
        if (typeof item.caption === "string") wire.caption = item.caption;
        return wire;
      });
      return bot.api.sendMediaGroup(chatId, items, options);
    },
    sendDocument: async (chatId, document, options) => {
      const { filename, rest } = popFilename(options, "document.bin");
      return bot.api.sendDocument(chatId, new InputFile(document, filename), rest);
    },
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

/**
 * MIME types Telegram's `sendPhoto` accepts as-is. Anything else gets
 * routed straight to `sendDocument` to skip a guaranteed-failure round
 * trip. Telegram itself sniffs the file bytes — it doesn't trust the
 * filename — but if the format isn't in this set we KNOW the photo path
 * will reject (PHOTO_INVALID_TYPE or similar), so don't bother trying.
 *
 * Sources: Telegram Bot API docs + observed real-world rejections.
 *   - `image/png` / `image/jpeg`: universally accepted.
 *   - `image/webp`: accepted (newer servers).
 *   - `image/gif`: static GIFs accepted as photo; animated lose animation.
 *   - `image/heic`, `image/heif`: accepted by recent Telegram servers.
 *   - `image/bmp`: deprecated but historically accepted.
 *
 * NOT accepted as photo (always document):
 *   - `image/svg+xml` (vector — no raster)
 *   - `image/tiff`, `image/avif`, `image/x-icon`
 *   - any `application/*` (PDFs sometimes show up here)
 */
const PHOTO_SUPPORTED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/bmp"
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "application/pdf": "pdf"
};

export function isPhotoSupportedMime(mediaType: string | undefined): boolean {
  return mediaType !== undefined && PHOTO_SUPPORTED_MIME.has(mediaType.toLowerCase());
}

/**
 * Returns true if `sendPhoto` callers should be redirected to
 * `sendDocument`. Default behavior (env var unset or `"true"`) prefers
 * documents — Telegram's photo path compresses, which destroys
 * legibility on screenshots / dense UI captures. Set the env var to
 * `"false"` (or any non-`"true"` non-`"1"` value) to opt into the old
 * compressed-but-inline-preview behavior.
 */
function preferDocumentForImages(): boolean {
  const raw = process.env.AGENT_CONNECT_IMAGE_AS_DOCUMENT;
  if (raw === undefined) return true; // default: preserve quality
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Map an image MIME type to a sensible filename. Telegram sniffs file
 * bytes for format detection, but the right extension is what the
 * recipient sees and what gets saved when they tap "save as".
 *
 * Unknown MIME types fall back to the subtype after the slash (e.g.
 * `image/foo` → `foo`), then to `bin` if nothing parseable.
 */
export function filenameFromMediaType(mediaType: string | undefined, idx = 0): string {
  const ext = (() => {
    if (!mediaType) return "png";
    const known = MIME_TO_EXT[mediaType.toLowerCase()];
    if (known) return known;
    const slash = mediaType.indexOf("/");
    if (slash > 0 && slash < mediaType.length - 1) return mediaType.slice(slash + 1).split("+")[0] || "bin";
    return "bin";
  })();
  return idx > 0 ? `screenshot-${idx + 1}.${ext}` : `screenshot.${ext}`;
}

export async function sendPhoto(
  api: TelegramApiLike,
  chatId: number,
  imageData: ToolResultImage[],
  options: Record<string, unknown> = {}
): Promise<void> {
  if (imageData.length === 0) return;

  // Telegram's `sendPhoto` ALWAYS recompresses the image (~1280px JPEG-ish)
  // which destroys legibility on screenshots — particularly code, terminal
  // captures, and dense UI. Users overwhelmingly want full quality.
  // Default `AGENT_CONNECT_IMAGE_AS_DOCUMENT=true` routes everything to
  // `sendDocument` (no compression, original quality, 50MB cap). Set to
  // `false` to use the old photo path (inline preview, but compressed).
  // Modern Telegram clients still show an inline thumbnail for image
  // documents, so the UX cost is small.
  if (preferDocumentForImages()) {
    await sendImagesAsDocuments(api, chatId, imageData, options);
    return;
  }

  // If ANY image is a format Telegram won't accept as a photo (SVG, TIFF,
  // PDF, etc.), skip sendPhoto/sendMediaGroup entirely and send each as a
  // document. Avoids a guaranteed-failure round trip + the warn log.
  if (imageData.some((img) => !isPhotoSupportedMime(img.mediaType))) {
    await sendImagesAsDocuments(api, chatId, imageData, options);
    return;
  }

  try {
    if (imageData.length === 1) {
      // For a single photo, `caption` lives directly on the send options.
      // Telegram caps captions at 1024 chars; we let the caller bound it.
      const opts = { ...options, filename: filenameFromMediaType(imageData[0]!.mediaType) };
      await api.sendPhoto?.(chatId, imageData[0]!.data, opts);
      return;
    }

    // For a media group, Telegram only honors `caption` when it's on the
    // FIRST media item (the group caption). If the caller passed `caption`
    // via options, lift it onto media[0] and strip it from the outer call.
    const caption = typeof options.caption === "string" ? options.caption : null;
    const { caption: _stripped, ...groupOptions } = options;
    await api.sendMediaGroup?.(
      chatId,
      imageData.map((image, idx) => ({
        type: "photo" as const,
        media: image.data,
        _filename: filenameFromMediaType(image.mediaType, idx),
        ...(idx === 0 && caption ? { caption } : {})
      })),
      groupOptions
    );
  } catch (error) {
    if (isRetryAfter(error)) throw error;
    // sendPhoto / sendMediaGroup can reject on:
    //   - PHOTO_INVALID_DIMENSIONS (one side > 10000 px or aspect > 20:1)
    //   - PHOTO_SAVE_FILE_INVALID (server-side validation failure)
    //   - 413 Payload Too Large (file > 10 MB)
    // Document upload bypasses photo compression: 50 MB cap, no dimension
    // cap, original quality preserved. Worth a single fallback attempt
    // before we give up.
    logger().warn(
      { err: error, photoCount: imageData.length },
      "sendPhoto failed; falling back to sendDocument (preserves original; 50MB cap)"
    );
    await sendImagesAsDocuments(api, chatId, imageData, options);
  }
}

async function sendImagesAsDocuments(
  api: TelegramApiLike,
  chatId: number,
  imageData: ToolResultImage[],
  options: Record<string, unknown>
): Promise<void> {
  const caption = typeof options.caption === "string" ? options.caption : null;
  const { caption: _strip, ...baseOptions } = options;
  for (let i = 0; i < imageData.length; i += 1) {
    const image = imageData[i]!;
    const docOptions: Record<string, unknown> = {
      ...baseOptions,
      filename: filenameFromMediaType(image.mediaType, i)
    };
    // Caption only on the first document, mirroring photo-group semantics.
    if (i === 0 && caption) docOptions.caption = caption;
    try {
      await api.sendDocument?.(chatId, image.data, docOptions);
    } catch (docError) {
      if (isRetryAfter(docError)) throw docError;
      logger().error(
        { err: docError, mediaType: image.mediaType, sizeBytes: image.data.length },
        "sendDocument fallback also failed — dropping this image"
      );
    }
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
