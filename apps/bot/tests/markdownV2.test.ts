import { describe, expect, it } from "vitest";
import { convertMarkdownToTelegramEntities } from "../src/agent-connect/markdownV2.js";
import { EXPANDABLE_QUOTE_END, EXPANDABLE_QUOTE_START } from "../src/agent-connect/transcriptParser.js";

describe("Telegram entity conversion", () => {
  it("preserves basic markdown formatting", () => {
    expect(convertMarkdownToTelegramEntities("**bold text**")).toEqual({
      text: "bold text",
      entities: [{ type: "bold", offset: 0, length: 9 }]
    });
    expect(convertMarkdownToTelegramEntities("*italic text*")).toEqual({
      text: "italic text",
      entities: [{ type: "italic", offset: 0, length: 11 }]
    });
    expect(convertMarkdownToTelegramEntities("`a_b`")).toEqual({
      text: "a_b",
      entities: [{ type: "code", offset: 0, length: 3 }]
    });
  });

  it("does not parse underscores inside words as italic markers", () => {
    expect(convertMarkdownToTelegramEntities("foo_bar_baz")).toEqual({
      text: "foo_bar_baz",
      entities: []
    });
    expect(convertMarkdownToTelegramEntities("path_with_under_scores.ts")).toEqual({
      text: "path_with_under_scores.ts",
      entities: []
    });
  });

  it("renders fenced code blocks as pre entities", () => {
    const result = convertMarkdownToTelegramEntities("```typescript\nconsole.log('hi')\n```");
    expect(result.text).toBe("console.log('hi')");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 17, language: "typescript" }]);
  });

  it("renders expandable quote sentinels", () => {
    const result = convertMarkdownToTelegramEntities(`${EXPANDABLE_QUOTE_START}quoted_content.${EXPANDABLE_QUOTE_END}`);
    expect(result.text).toBe("quoted_content.");
    expect(result.entities).toEqual([{ type: "expandable_blockquote", offset: 0, length: 15 }]);
  });

  it("keeps surrounding text when rendering expandable quotes", () => {
    const result = convertMarkdownToTelegramEntities(
      `before ${EXPANDABLE_QUOTE_START}inside quote${EXPANDABLE_QUOTE_END} after`
    );
    expect(result.text).toBe("before inside quote after");
    expect(result.entities).toEqual([{ type: "expandable_blockquote", offset: 7, length: 12 }]);
  });

  it("uses telegramify-markdown for table entities", () => {
    const result = convertMarkdownToTelegramEntities(
      '| 场景 | 该用 | 不该用 |\n| --- | --- | --- |\n| 按钮点击的即时反馈 | `query.answer("text")` | `reply_text` |'
    );
    expect(result.text).toContain('│ 按钮点击的即时反馈 │ query.answer("text") │ reply_text │');
    expect(result.entities).toContainEqual(
      expect.objectContaining({ type: "pre", offset: 0, length: result.text.length })
    );
  });
});
