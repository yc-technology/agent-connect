import { describe, expect, it } from "vitest";
import { buildResponseParts } from "../src/agent-connect/responseBuilder.js";
import { EXPANDABLE_QUOTE_END, EXPANDABLE_QUOTE_START } from "../src/agent-connect/transcriptParser.js";

describe("buildResponseParts", () => {
  it("prefixes and truncates user messages", () => {
    expect(buildResponseParts("hello", true, "text", "user")[0]).toContain("👤");
    expect(buildResponseParts("a".repeat(4000), true, "text", "user")[0]!.length).toBeLessThan(4000);
  });

  it("truncates complete thinking content", () => {
    const parts = buildResponseParts(
      `${EXPANDABLE_QUOTE_START}${"x".repeat(800)}${EXPANDABLE_QUOTE_END}`,
      true,
      "thinking"
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.toLowerCase()).toContain("truncated");
  });

  it("splits long plain text with page suffixes", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `line ${i} ${"padding".repeat(50)}`).join("\n");
    const parts = buildResponseParts(longText, true);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain("1/");
  });

  it("keeps expandable quote atomic", () => {
    const parts = buildResponseParts(
      `${EXPANDABLE_QUOTE_START}${"thought ".repeat(100)}${EXPANDABLE_QUOTE_END}`,
      false,
      "thinking"
    );
    expect(parts).toHaveLength(1);
  });

  it("adds thinking prefix but no assistant text prefix", () => {
    expect(buildResponseParts("some thought", true, "thinking")[0]).toContain("Thinking");
    expect(buildResponseParts("hello", true, "text", "assistant")[0]).not.toContain("👤");
  });
});
