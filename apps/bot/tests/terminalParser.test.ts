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

  it("extracts Codex PermissionPrompt (Would you like to run + Press enter to confirm)", () => {
    const pane =
      "› 现在可以了你再试试\n" +
      "\n" +
      "• 我用一个安全的 GUI 操作来测试：\n" +
      "\n" +
      "• Running open /tmp/foo.png\n" +
      "\n" +
      "  Would you like to run the following command?\n" +
      "\n" +
      "  Reason: 是否允许打开本地截图文件来测试权限审批交互？\n" +
      "\n" +
      "  $ open\n" +
      "  /tmp/foo.png\n" +
      "\n" +
      "› 1. Yes, proceed (y)\n" +
      "  2. Yes, and don't ask again for commands that start with `open /tmp` (p)\n" +
      "  3. No, and tell Codex what to do differently (esc)\n" +
      "\n" +
      "  Press enter to confirm or esc to cancel\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("PermissionPrompt");
    expect(result?.content).toContain("Would you like to run the following command?");
    expect(result?.content).toContain("Reason:");
    expect(result?.content).toContain("› 1. Yes, proceed");
    expect(result?.content).toContain("Press enter to confirm");
    expect(result?.content).not.toContain("现在可以了你再试试");
  });

  it("extracts Codex AskUserQuestion (numbered options + tab/enter/esc footer)", () => {
    // Real Codex 0.130 pane capture during an AskUserQuestion prompt.
    const pane =
      "› 现在可以了吧\n" +
      "\n" +
      "• 切到 Plan Mode 了。\n" +
      "\n" +
      "  Question 1/1 (1 unanswered)\n" +
      "  请选择这次 ask user 能力测试的方向。\n" +
      "\n" +
      "  › 1. 只做演示 (Recommended)  验证选择器能弹出并回传答案，不修改仓库。\n" +
      "    2. 检查实现                读取 packages/cli 中 ask user 相关代码。\n" +
      "    3. 规划测试                制定 ask user 的手动和自动化测试方案。\n" +
      "    4. None of the above       Optionally, add details in notes (tab).\n" +
      "\n" +
      "  tab to add notes | enter to submit answer | esc to interrupt\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("AskUserQuestion");
    expect(result?.content).toContain("Question 1/1");
    expect(result?.content).toContain("› 1. 只做演示");
    expect(result?.content).toContain("tab to add notes");
    // Should NOT bleed earlier non-prompt context into the extraction.
    expect(result?.content).not.toContain("现在可以了吧");
    expect(result?.content).not.toContain("Plan Mode");
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
