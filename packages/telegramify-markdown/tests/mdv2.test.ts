import { describe, expect, it } from "vitest";
import {
  _escape_code,
  _escape_markdownv2,
  _escape_url,
  entitiesToMarkdownV2,
  splitMarkdownV2,
  utf16Len,
  type MessageEntity
} from "../src/index.js";

describe("MarkdownV2 renderer", () => {
  it("escapes plain text, code, and URLs with Telegram rules", () => {
    expect(_escape_markdownv2("a*b")).toBe("a\\*b");
    expect(_escape_code("a`b\\c*d")).toBe("a\\`b\\\\c*d");
    expect(_escape_url("http://a.com/b(c)d\\e")).toBe("http://a.com/b(c\\)d\\\\e");
  });

  it("renders common entities", () => {
    expect(entitiesToMarkdownV2("hello world", [{ type: "bold", offset: 0, length: 5 }])).toBe(
      "*hello* world"
    );
    expect(entitiesToMarkdownV2("use print()", [{ type: "code", offset: 4, length: 7 }])).toBe(
      "use `print()`"
    );
    expect(
      entitiesToMarkdownV2("link", [
        { type: "text_link", offset: 0, length: 4, url: "https://a.com/b(c)" }
      ])
    ).toBe("[link](https://a.com/b(c\\))");
  });

  it("renders nested entities without crossing markers", () => {
    const entities: MessageEntity[] = [
      { type: "bold", offset: 0, length: 15 },
      { type: "italic", offset: 5, length: 6 }
    ];
    expect(entitiesToMarkdownV2("bold italic end", entities)).toBe("*bold _italic_ end*");
  });

  it("renders pre and blockquote entities", () => {
    expect(
      entitiesToMarkdownV2("console.log(1)", [{ type: "pre", offset: 0, length: 14, language: "typescript" }])
    ).toBe("```typescript\nconsole.log(1)\n```");

    const quote = "line1\nline2";
    expect(
      entitiesToMarkdownV2(quote, [{ type: "blockquote", offset: 0, length: utf16Len(quote) }])
    ).toBe(">line1\n>line2");
  });

  it("splits rendered MarkdownV2 under the max length", () => {
    const chunks = splitMarkdownV2("a_b_c_d", [], 4);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => utf16Len(chunk) <= 4)).toBe(true);
  });
});
