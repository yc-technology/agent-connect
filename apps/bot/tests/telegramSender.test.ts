import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/agent-connect/telegramSender.js";

describe("splitMessage", () => {
  it("returns one chunk for short text", () => {
    expect(splitMessage("hello world")).toEqual(["hello world"]);
    expect(splitMessage("")).toEqual([""]);
  });

  it("splits on newline boundaries", () => {
    const line = "x".repeat(2000);
    expect(splitMessage(`${line}\n${line}\n${line}`)).toEqual([
      `${line}\n${line}`,
      line
    ]);
  });

  it("force splits a long line", () => {
    const chunks = splitMessage("a".repeat(8192));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(4096));
    expect(chunks[1]).toBe("a".repeat(4096));
  });

  it("closes and reopens split code blocks", () => {
    const code = "```typescript\n" + Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n```";
    const chunks = splitMessage(code, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith("```")).toBe(true);
    expect(chunks[1]?.startsWith("```typescript")).toBe(true);
  });
});
