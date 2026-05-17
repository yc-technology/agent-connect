import { describe, expect, it } from "vitest";
import { ContentType, processMarkdown } from "../src/index.js";

describe("pipeline", () => {
  it("returns text content with entities", async () => {
    const results = await processMarkdown("Hello **world**");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ contentType: ContentType.TEXT, text: "Hello world" });
  });

  it("extracts code blocks as files by default", async () => {
    const results = await processMarkdown("Before\n\n```typescript\nconsole.log('hello')\n```\n\nAfter");
    expect(results.map((item) => item.contentType)).toEqual([
      ContentType.TEXT,
      ContentType.FILE,
      ContentType.TEXT
    ]);
  });

  it("can keep code blocks inline", async () => {
    const results = await processMarkdown("```typescript\nconsole.log('hello')\n```", { minFileLines: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ contentType: ContentType.TEXT });
  });
});
