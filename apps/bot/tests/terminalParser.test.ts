import { describe, expect, it } from "vitest";
import {
  extractBashOutput,
  extractInteractiveContent,
  isCompletedStatusLine,
  isInteractiveUi,
  parseStatusLine,
  stripPaneChrome
} from "../src/agent-connect/terminalParser.js";

const chrome =
  "──────────────────────────────────────\n" +
  "❯ \n" +
  "──────────────────────────────────────\n" +
  "  [Opus 4.6] Context: 50%\n";

describe("parseStatusLine", () => {
  it.each([
    ["·", "Working on task", "Working on task"],
    ["✻", "  Reading file  ", "Reading file"],
    ["✽", "Thinking deeply", "Thinking deeply"],
    ["✶", "Analyzing code", "Analyzing code"],
    ["✳", "Processing input", "Processing input"],
    ["✢", "Building project", "Building project"]
  ])("parses spinner %s", (spinner, rest, expected) => {
    expect(parseStatusLine(`some output\n${spinner}${rest}\n${chrome}`)).toBe(expected);
  });

  it("requires chrome", () => {
    expect(parseStatusLine("output\n✻ Doing work\nno chrome here\n")).toBeNull();
  });

  it("does not treat regular bullet output as status", () => {
    expect(parseStatusLine(`· one\n· two\nresult\n${chrome}`)).toBeNull();
  });

  it("identifies Claude completed status lines", () => {
    expect(isCompletedStatusLine("Cooked for 3s")).toBe(true);
    expect(isCompletedStatusLine("Baked for 1.5s")).toBe(true);
    expect(isCompletedStatusLine("Reading file")).toBe(false);
  });
});

describe("interactive UI extraction", () => {
  it("extracts ExitPlanMode", () => {
    const result = extractInteractiveContent(
      "  Would you like to proceed?\n  ─────────────────────────────────\n  Yes     No\n  ─────────────────────────────────\n  ctrl-g to edit in vim\n"
    );
    expect(result?.name).toBe("ExitPlanMode");
    expect(result?.content).toContain("Would you like to proceed?");
  });

  it("extracts Settings model picker", () => {
    const result = extractInteractiveContent(
      " Select model\n" +
        " Switch between Claude models.\n\n" +
        "   1. Default\n" +
        " ❯ 2. Sonnet\n\n" +
        " Enter to confirm · Esc to exit\n"
    );
    expect(result?.name).toBe("Settings");
    expect(result?.content).toContain("Sonnet");
  });

  it("returns null for normal pane", () => {
    expect(extractInteractiveContent("$ echo hello\nhello\n$\n")).toBeNull();
    expect(isInteractiveUi("")).toBe(false);
  });
});

describe("stripPaneChrome", () => {
  it("strips from chrome separator", () => {
    const lines = ["some output", "more output", "─".repeat(30), "❯", "─".repeat(30)];
    expect(stripPaneChrome(lines)).toEqual(["some output", "more output"]);
  });
});

describe("extractBashOutput", () => {
  it("extracts command output", () => {
    const result = extractBashOutput("context\n! echo hello\n⎿ hello\n", "echo hello");
    expect(result).toContain("! echo hello");
    expect(result).toContain("hello");
  });

  it("strips chrome", () => {
    const pane = `context\n! ls\n⎿ file.txt\n${"─".repeat(30)}\n❯\n${"─".repeat(30)}\n  [Opus 4.6]\n`;
    const result = extractBashOutput(pane, "ls");
    expect(result).toContain("file.txt");
    expect(result).not.toContain("Opus");
  });
});
