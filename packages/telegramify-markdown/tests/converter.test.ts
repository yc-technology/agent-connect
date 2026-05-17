import { describe, expect, it } from "vitest";
import { convert, convertWithSegments, markdownify } from "../src/index.js";

function findEntity(entities: Array<{ type: string }>, type: string) {
  return entities.find((entity) => entity.type === type);
}

describe("Markdown converter", () => {
  it("converts basic inline formatting", () => {
    const [text, entities] = convert("foo **bar** *baz* ~~old~~ `code`", { latexEscape: false });
    expect(text).toContain("foo bar baz old code");
    expect(findEntity(entities, "bold")).toBeTruthy();
    expect(findEntity(entities, "italic")).toBeTruthy();
    expect(findEntity(entities, "strikethrough")).toBeTruthy();
    expect(findEntity(entities, "code")).toBeTruthy();
  });

  it("renders headings with Telegram-friendly styling", () => {
    const [text, entities] = convert("# Title", { latexEscape: false });
    expect(text).toContain("📌 Title");
    expect(findEntity(entities, "bold")).toBeTruthy();
    expect(findEntity(entities, "underline")).toBeTruthy();
  });

  it("converts links, images, custom emoji, and spoilers", () => {
    const [text, entities] = convert(
      "[site](https://example.com) ![img](https://example.com/a.png) ![😀](tg://emoji?id=5368324170671202286) ||secret||",
      { latexEscape: false }
    );
    expect(text).toContain("site");
    expect(text).toContain("🖼");
    expect(text).toContain("😀");
    expect(text).toContain("secret");
    expect(findEntity(entities, "text_link")).toBeTruthy();
    expect(findEntity(entities, "custom_emoji")).toBeTruthy();
    expect(findEntity(entities, "spoiler")).toBeTruthy();
  });

  it("renders tables as preformatted box tables", () => {
    const [text, entities] = convert("| 场景 | 该用 |\n| --- | --- |\n| 点击 | `query.answer()` |", {
      latexEscape: false
    });
    expect(text).toContain("┌");
    expect(text).toContain("│ 点击 │ query.answer() │");
    expect(findEntity(entities, "pre")).toBeTruthy();
  });

  it("tracks code block segments", () => {
    const [text, entities, segments] = convertWithSegments("```typescript\nconsole.log('hi')\n```", {
      latexEscape: false
    });
    expect(text).toContain("console.log('hi')");
    expect(findEntity(entities, "pre")).toMatchObject({ language: "typescript" });
    expect(segments[0]).toMatchObject({ kind: "code_block", language: "typescript" });
  });

  it("returns MarkdownV2 through the default-style API", () => {
    expect(markdownify("**bold** and `\\*`", { latexEscape: false })).toBe("*bold* and `\\\\*`");
  });
});
