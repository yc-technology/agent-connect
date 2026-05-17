import { describe, expect, it } from "vitest";
import { approximate256Color, DEFAULT_FG, parseAnsiLine, textToImage, textToSvg } from "../src/agent-connect/screenshot.js";

describe("screenshot rendering", () => {
  it("parses basic and extended ANSI colors", () => {
    const segments = parseAnsiLine("normal \x1b[31mred\x1b[0m \x1b[38;2;1;2;3mrgb");

    expect(segments.map((segment) => segment.text)).toEqual(["normal ", "red", " ", "rgb"]);
    expect(segments[0]?.style.fgColor).toEqual(DEFAULT_FG);
    expect(segments[1]?.style.fgColor).toEqual([205, 49, 49]);
    expect(segments[3]?.style.fgColor).toEqual([1, 2, 3]);
  });

  it("approximates 256 color cube values", () => {
    expect(approximate256Color(16)).toEqual([0, 0, 0]);
    expect(approximate256Color(231)).toEqual([255, 255, 255]);
    expect(approximate256Color(232)).toEqual([8, 8, 8]);
  });

  it("escapes text in generated SVG", () => {
    const svg = textToSvg("<tag>&value", { withAnsi: false, fontSize: 12 });

    expect(svg).toContain("&lt;tag&gt;&amp;value");
    expect(svg).toContain("<svg");
  });

  it("renders PNG bytes", async () => {
    const png = await textToImage("hello\n\x1b[32mworld\x1b[0m", { fontSize: 14, withAnsi: true });

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(100);
  });
});
