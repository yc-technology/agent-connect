import { describe, expect, it } from "vitest";
import { splitEntities, utf16Len, type MessageEntity } from "../src/index.js";

describe("entity helpers", () => {
  it("measures Telegram UTF-16 offsets", () => {
    expect(utf16Len("hello")).toBe(5);
    expect(utf16Len("你好")).toBe(2);
    expect(utf16Len("📌")).toBe(2);
    expect(utf16Len("🇺🇸")).toBe(4);
  });

  it("splits text and clips entities", () => {
    const text = "bold\nnormal";
    const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 4 }];
    const chunks = splitEntities(text, entities, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.[1][0]).toMatchObject({ type: "bold", offset: 0, length: 4 });
    expect(chunks.map(([chunk]) => chunk).join("")).toBe(text);
  });

  it("does not split inside surrogate pairs", () => {
    const chunks = splitEntities("📌\n📌\n📌", [], 4);
    expect(chunks.map(([chunk]) => chunk).join("")).toBe("📌\n📌\n📌");
  });
});
