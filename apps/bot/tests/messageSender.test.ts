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

  it("sends one photo or a media group", async () => {
    const api: TelegramApiLike = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendMediaGroup: vi.fn()
    };

    await sendPhoto(api, 100, [{ mediaType: "image/png", data: Buffer.from("one") }]);
    expect(api.sendPhoto).toHaveBeenCalledWith(100, Buffer.from("one"), {});

    await sendPhoto(api, 100, [
      { mediaType: "image/png", data: Buffer.from("one") },
      { mediaType: "image/png", data: Buffer.from("two") }
    ]);
    expect(api.sendMediaGroup).toHaveBeenCalledWith(
      100,
      [
        { type: "photo", media: Buffer.from("one") },
        { type: "photo", media: Buffer.from("two") }
      ],
      {}
    );
  });
});
