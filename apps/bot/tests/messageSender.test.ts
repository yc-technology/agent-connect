import { describe, expect, it, vi } from "vitest";
import {
  editWithFallback,
  ensureEntityFormatted,
  sendPhoto,
  sendWithFallback,
  stripSentinels,
  type TelegramApiLike
} from "../src/agent-connect/messageSender.js";
import { EXPANDABLE_QUOTE_END, EXPANDABLE_QUOTE_START } from "../src/agent-connect/transcriptParser.js";

describe("messageSender", () => {
  it("strips expandable quote sentinels", () => {
    expect(stripSentinels(`${EXPANDABLE_QUOTE_START}text${EXPANDABLE_QUOTE_END}`)).toBe("text");
  });

  it("keeps plain text unchanged for entity sends", () => {
    expect(ensureEntityFormatted("hello_world. (ok)!")).toEqual({
      text: "hello_world. (ok)!",
      entities: []
    });
  });

  it("formats expandable quote sentinels", () => {
    expect(ensureEntityFormatted(`${EXPANDABLE_QUOTE_START}hello${EXPANDABLE_QUOTE_END}`)).toEqual({
      text: "hello",
      entities: [{ type: "expandable_blockquote", offset: 0, length: 5 }]
    });
  });

  it("sends entity-formatted messages first", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi.fn(async () => ({ message_id: 1 }))
    };

    const sent = await sendWithFallback(api, 100, "**hello**", { message_thread_id: 42 });

    expect(sent?.message_id).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      100,
      "hello",
      expect.objectContaining({
        entities: [{ type: "bold", offset: 0, length: 5 }],
        message_thread_id: 42
      })
    );
  });

  it("falls back to plain text when entity send fails", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("bad entities"))
        .mockResolvedValueOnce({ message_id: 2 })
    };

    const sent = await sendWithFallback(api, 100, `${EXPANDABLE_QUOTE_START}hello${EXPANDABLE_QUOTE_END}`);

    expect(sent?.message_id).toBe(2);
    expect(api.sendMessage).toHaveBeenNthCalledWith(
      2,
      100,
      "hello",
      expect.not.objectContaining({ entities: expect.any(Array) })
    );
  });

  it("edits with plain fallback after entity formatting fails", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      editMessageText: vi
        .fn()
        .mockRejectedValueOnce(new Error("bad entities"))
        .mockResolvedValueOnce(undefined)
    };

    await expect(editWithFallback(api, 100, 7, `${EXPANDABLE_QUOTE_START}hello${EXPANDABLE_QUOTE_END}`)).resolves.toBe(
      true
    );
    expect(api.editMessageText).toHaveBeenNthCalledWith(
      2,
      100,
      7,
      "hello",
      expect.not.objectContaining({ entities: expect.any(Array) })
    );
  });

  it("sends one photo or a media group with mediaType-derived filenames", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendMediaGroup: vi.fn()
    };

    await sendPhoto(api, 100, [{ mediaType: "image/png", data: Buffer.from("one") }]);
    expect(api.sendPhoto).toHaveBeenCalledWith(100, Buffer.from("one"), {
      filename: "screenshot.png"
    });

    await sendPhoto(api, 100, [{ mediaType: "image/jpeg", data: Buffer.from("jpg") }]);
    expect(api.sendPhoto).toHaveBeenLastCalledWith(100, Buffer.from("jpg"), {
      filename: "screenshot.jpg"
    });

    await sendPhoto(api, 100, [
      { mediaType: "image/png", data: Buffer.from("one") },
      { mediaType: "image/webp", data: Buffer.from("two") }
    ]);
    expect(api.sendMediaGroup).toHaveBeenCalledWith(
      100,
      [
        { type: "photo", media: Buffer.from("one"), _filename: "screenshot.png" },
        { type: "photo", media: Buffer.from("two"), _filename: "screenshot-2.webp" }
      ],
      {}
    );
  });

  it("falls back to sendDocument when sendPhoto throws a non-rate-limit error", async () => {
    // PHOTO_INVALID_DIMENSIONS / 413 too-large → photo path rejects.
    // Document path should be tried with the same caption + filename.
    const photoErr = new Error("Bad Request: PHOTO_INVALID_DIMENSIONS");
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(async () => {
        throw photoErr;
      }),
      sendDocument: vi.fn()
    };

    await sendPhoto(
      api,
      100,
      [{ mediaType: "image/png", data: Buffer.from("hi") }],
      { caption: "📷 Screenshot", message_thread_id: 42 }
    );

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendDocument).toHaveBeenCalledWith(
      100,
      Buffer.from("hi"),
      {
        caption: "📷 Screenshot",
        message_thread_id: 42,
        filename: "screenshot.png"
      }
    );
  });

  it("media-group fallback to sendDocument lifts caption onto the first document only", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      sendMediaGroup: vi.fn(async () => {
        throw new Error("Bad Request: MEDIA_INVALID");
      }),
      sendDocument: vi.fn()
    };

    await sendPhoto(
      api,
      100,
      [
        { mediaType: "image/png", data: Buffer.from("a") },
        { mediaType: "image/jpeg", data: Buffer.from("b") }
      ],
      { caption: "two shots" }
    );

    expect(api.sendDocument).toHaveBeenCalledTimes(2);
    expect(api.sendDocument).toHaveBeenNthCalledWith(1, 100, Buffer.from("a"), {
      filename: "screenshot.png",
      caption: "two shots"
    });
    // Second doc: NO caption (Telegram media-group semantics: caption only
    // on the first item).
    expect(api.sendDocument).toHaveBeenNthCalledWith(2, 100, Buffer.from("b"), {
      filename: "screenshot-2.jpg"
    });
  });

  it("propagates retry-after instead of falling back to sendDocument on 429", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(async () => {
        const err = Object.assign(new Error("429"), { parameters: { retry_after: 3 } });
        throw err;
      }),
      sendDocument: vi.fn()
    };

    await expect(
      sendPhoto(api, 100, [{ mediaType: "image/png", data: Buffer.from("x") }])
    ).rejects.toMatchObject({ parameters: { retry_after: 3 } });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("routes Telegram-unsupported MIME types straight to sendDocument", async () => {
    // image/svg+xml is vector — Telegram's sendPhoto would reject it.
    // image/pdf and image/tiff likewise. Skip the doomed photo attempt.
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendDocument: vi.fn()
    };

    await sendPhoto(api, 100, [{ mediaType: "image/svg+xml", data: Buffer.from("<svg/>") }]);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendDocument).toHaveBeenCalledWith(100, Buffer.from("<svg/>"), {
      filename: "screenshot.svg"
    });

    await sendPhoto(api, 100, [{ mediaType: "application/pdf", data: Buffer.from("%PDF") }]);
    expect(api.sendDocument).toHaveBeenLastCalledWith(100, Buffer.from("%PDF"), {
      filename: "screenshot.pdf"
    });
  });
});
