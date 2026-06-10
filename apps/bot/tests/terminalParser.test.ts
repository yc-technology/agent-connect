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

  it("parses /compact progress: spinner + progress bar + Tip continuation", () => {
    // Real `tmux capture-pane` shape during /compact: the spinner status line
    // sits 3-4 rows above the chrome separator because Claude attaches a
    // progress bar AND a "⎿ Tip:" with an indented continuation below it.
    const pane =
      "❯ /compact\n" +
      "\n" +
      "✻ Compacting conversation… (17s)\n" +
      "  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 18%\n" +
      "  ⎿  Tip: Working with HTML/CSS? Install the frontend-design plugin:\n" +
      "     /plugin install frontend-design@claude-plugins-official\n" +
      "\n" +
      "──────────────────────────────────────\n" +
      "❯ \n" +
      "──────────────────────────────────────\n" +
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\n";
    expect(parseStatusLine(pane)).toBe("Compacting conversation… (17s) 18%");
  });

  it("falls back to status only when the progress bar percent is missing", () => {
    const pane =
      "✻ Working on it\n" +
      "  ⎿  Tip: random hint here\n" +
      "──────────────────────────────────────\n" +
      "❯ \n" +
      "──────────────────────────────────────\n" +
      "  [Opus 4.6] Context: 50%\n";
    expect(parseStatusLine(pane)).toBe("Working on it");
  });

  it("walks past Claude `● ...` system notifications between spinner and chrome", () => {
    // Real symptom from a live cc-dog:techbooks-project session: Claude's
    // periodic "How is Claude doing this session?" rating prompt landed
    // between the spinner and the chrome, terminating walk-back early →
    // parseStatusLine returned null → statusPolling never overrode the
    // runtime's "Thinking..." status. User saw only "Thinking..." for
    // minutes despite the spinner being live.
    const pane =
      "✶ Hashing… (3m 21s · ↓ 9.1k tokens)\n" +
      "  ⎿  Tip: Use /btw to ask a quick side question\n" +
      "\n" +
      "● How is Claude doing this session? (optional)\n" +
      "  1: Bad    2: Fine   3: Good   0: Dismiss\n" +
      "\n" +
      "───────────────────────────────────────\n" +
      "❯ \n" +
      "───────────────────────────────────────\n" +
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\n";
    expect(parseStatusLine(pane)).toBe("Hashing… (3m 21s · ↓ 9.1k tokens)");
  });

  it("anchors on upper chrome when input is sandwiched between TWO chromes (live regression)", () => {
    // Live regression from cc-dog:creative-project on 2026-05-25. The TUI
    // rendered the input row with chrome BOTH above AND below it:
    //     ✻ Worked for 36s
    //     [blank]
    //     ● How is Claude doing this session? (optional)
    //       1: Bad  2: Fine  3: Good  0: Dismiss
    //     [blank]
    //     ─────────────────  ← chrome 1 (above input)
    //     ❯ <user input echo>
    //     ─────────────────  ← chrome 2 (below input)
    //       ⏵⏵ bypass permissions ...
    //     [blank padding × 7]
    // searchStart was lines.length-10, which only saw chrome 2. Walk-back
    // from chrome 2 hits `❯` immediately and breaks — status detection
    // returned null, Telegram stayed stuck on the previous spinner text
    // ("Manifesting…") forever.
    const pane =
      "✻ Worked for 36s\n" +
      "\n" +
      "● How is Claude doing this session? (optional)\n" +
      "  1: Bad    2: Fine   3: Good   0: Dismiss\n" +
      "\n" +
      "────────────────────────────────────────────────────────────────────────────────\n" +
      "❯ commit 这些改动\n" +
      "────────────────────────────────────────────────────────────────────────────────\n" +
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n" +
      "\n\n\n\n\n\n\n";
    expect(parseStatusLine(pane)).toBe("Worked for 36s");
    expect(isCompletedStatusLine("Worked for 36s")).toBe(true);
  });

  it("walks past Claude `⏺ ...` (U+23FA, record-circle) session-transcript prompt", () => {
    // Live regression from cc-dog:techbooks-project: Claude's "Can Anthropic
    // look at your session transcript?" telemetry prompt uses U+23FA
    // (RECORD-CIRCLE), NOT U+25CF (BLACK CIRCLE) — the previous `●` skip
    // rule didn't catch it, so walk-back terminated on the prompt → status
    // detection failed → user saw only the generic "Thinking..." for
    // minutes while the real `✢ Fiddle-faddling… (3m 33s)` was right there.
    const pane =
      "✢ Fiddle-faddling… (3m 33s · ↑ 11.7k tokens · almost done thinking)\n" +
      "  ⎿  Tip: Use /btw to ask a quick side question\n" +
      "\n" +
      "⏺ Can Anthropic look at your session transcript to help us improve Claude Code?\n" +
      "  Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys\n" +
      "  y: Yes    n: No     d: Don't ask again\n" +
      "\n" +
      "───────────────────────────────────────\n" +
      "❯ \n" +
      "───────────────────────────────────────\n" +
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\n";
    expect(parseStatusLine(pane)).toBe(
      "Fiddle-faddling… (3m 33s · ↑ 11.7k tokens · almost done thinking)"
    );
  });

  it("identifies Claude completed status lines", () => {
    expect(isCompletedStatusLine("Cooked for 3s")).toBe(true);
    expect(isCompletedStatusLine("Baked for 1.5s")).toBe(true);
    expect(isCompletedStatusLine("Reading file")).toBe(false);
  });

  it("identifies accented past-tense verbs as completed status lines", () => {
    // Claude's verb pool includes accented words; the previous
    // ASCII-only [A-Za-z] regex silently let these through and they
    // showed up as still-active status in Telegram.
    expect(isCompletedStatusLine("Sautéed for 17s")).toBe(true);
    expect(isCompletedStatusLine("Flambéed for 5s")).toBe(true);
    expect(isCompletedStatusLine("Sautéed for 1.2s")).toBe(true);
    // Negative cases — must NOT match these even with Unicode letter class.
    expect(isCompletedStatusLine("Sauté for 17s")).toBe(false); // no trailing "ed"
    expect(isCompletedStatusLine("Sautéing for 17s")).toBe(false);
    expect(isCompletedStatusLine("Reading file")).toBe(false);
  });

  it("identifies multi-unit durations (m / h) on completed status lines", () => {
    // Claude switches from "Xs" to "Nm Ms" / "Hh Mm" when the step runs
    // past 1 minute. The seconds-only regex missed all of these and they
    // showed up in Telegram.
    expect(isCompletedStatusLine("Worked for 1m 5s")).toBe(true);
    expect(isCompletedStatusLine("Cooked for 2m 13s")).toBe(true);
    expect(isCompletedStatusLine("Brewed for 1m")).toBe(true);
    expect(isCompletedStatusLine("Baked for 1h 30m")).toBe(true);
    expect(isCompletedStatusLine("Sautéed for 2h 13m 45s")).toBe(true);
    expect(isCompletedStatusLine("Worked for 1m 5s · 1 shell still running")).toBe(true);
    // Negative: no unit, or wrong order, or no leading digits.
    expect(isCompletedStatusLine("Worked for 1m5s")).toBe(false); // tokens require a space
    expect(isCompletedStatusLine("Worked for m 5s")).toBe(false);
    expect(isCompletedStatusLine("Worked for 5")).toBe(false); // missing unit
  });

  it("identifies completed status lines with a `· side note` suffix", () => {
    // Claude appends background state after the duration with a middle-dot
    // separator: "Brewed for 34s · 1 shell still running" / "... · 2 shells
    // still running". Still a completion — should clear the Telegram status.
    expect(isCompletedStatusLine("Brewed for 34s · 1 shell still running")).toBe(true);
    expect(isCompletedStatusLine("Cooked for 5s · 2 shells still running")).toBe(true);
    expect(isCompletedStatusLine("Sautéed for 17s · 1 background task")).toBe(true);
    expect(isCompletedStatusLine("Brewed for 34s·1 shell")).toBe(true); // no space around ·
    // Negative: still need the duration before the dot.
    expect(isCompletedStatusLine("Brewed · 1 shell still running")).toBe(false);
    expect(isCompletedStatusLine("Brewed for · 1 shell")).toBe(false);
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

  it("extracts the Claude Code 2.x /model picker (verbatim 2026-06 capture)", () => {
    // Pinned from a live pane. This exact picker swallowed user messages
    // twice (text became keystrokes, Enter confirmed the highlighted model),
    // so the inbound-message guard depends on this UI staying detectable.
    // If a Claude Code update changes the chrome and this test fails, update
    // the Settings pattern in UI_PATTERNS — do not delete the test.
    const result = extractInteractiveContent(
      "❯ /model\n" +
        "────────────────────────\n" +
        "  Select model\n" +
        "  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous\n" +
        "  model names, specify with --model.\n" +
        "    1. Default (recommended)  Sonnet 4.6 · Efficient for routine tasks\n" +
        "    2. Sonnet (1M context)    Sonnet 4.6 with 1M context · Draws from usage credits\n" +
        "  ❯ 3. Fable ✔                Fable 5 · Most capable for your hardest and longest-running tasks\n" +
        "    4. Opus                   Opus 4.8 · Best for everyday, complex tasks\n" +
        "    5. Haiku                  Haiku 4.5 · Fastest for quick answers\n" +
        "  ● High effort (default) ←/→ to adjust\n" +
        "  Use /fast to turn on Fast mode (Opus 4.8).\n" +
        "  Enter to set as default · s to use this session only · Esc to cancel\n"
    );
    expect(result?.name).toBe("Settings");
    expect(result?.content).toContain("Fable");
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

  it("extracts Codex Settings: /model picker", () => {
    const pane =
      "  some prior output\n" +
      "\n" +
      "  Select Model and Effort\n" +
      "  Access legacy models by running codex -m <model_name> or in your config.toml\n" +
      "\n" +
      "› 1. gpt-5.5 (current)    Frontier model.\n" +
      "  2. gpt-5.4              Strong model.\n" +
      "  3. gpt-5.4-mini         Small, fast.\n" +
      "\n" +
      "  Press enter to confirm or esc to go back\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("Settings");
    expect(result?.content).toContain("Select Model and Effort");
    expect(result?.content).toContain("gpt-5.5 (current)");
    expect(result?.content).toContain("Press enter to confirm or esc to go back");
    expect(result?.content).not.toContain("some prior output");
  });

  it("extracts Codex Edit/Patch approval (Would you like to make the following edits)", () => {
    const pane =
      "• Added .approval-test.tmp (+1 -0)\n" +
      "    1 +approval test\n" +
      "\n" +
      "  Would you like to make the following edits?\n" +
      "\n" +
      "› 1. Yes, proceed (y)\n" +
      "  2. Yes, and don't ask again for these files (a)\n" +
      "  3. No, and tell Codex what to do differently (esc)\n" +
      "\n" +
      "  Press enter to confirm or esc to cancel\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("PermissionPrompt");
    expect(result?.content).toContain("Would you like to make the following edits");
    expect(result?.content).toContain("Yes, and don't ask again for these files");
    expect(result?.content).toContain("Press enter to confirm");
  });

  it("extracts Claude /resume session picker", () => {
    // Real capture from `claude --resume` (slash command form): a "Resume session
    // (N of M)" header, a search box, project label, several session rows with
    // `❯` cursor + metadata, and a long footer ending in `... Type to search ·
    // Esc to cancel`. The footer wraps on narrow panes — both top and bottom
    // markers above need to survive that wrap.
    const pane =
      "❯ /resume\n" +
      "\n" +
      "───────────────────────────────────────\n" +
      "  Resume session (1 of 9)\n" +
      "  ╭─────────────────────────────────────╮\n" +
      "  │ ⌕ Search…                           │\n" +
      "  ╰─────────────────────────────────────╯\n" +
      "    creative-project\n" +
      "\n" +
      "  ❯ Document Tauri reference from Chrome extension\n" +
      "    30 seconds ago · HEAD · 10.5MB\n" +
      "\n" +
      "    Reduce width of left sidebar layout\n" +
      "    1 day ago · HEAD · 102.4KB\n" +
      "\n" +
      "  ↓ /clear\n" +
      "    1 day ago · HEAD · 18.1KB\n" +
      "\n" +
      "    Ctrl+A to show all projects · Ctrl+B to only show current branch · Space to preview · Ctrl+R to\n" +
      "    rename · Type to search · Esc to cancel\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("ResumeSession");
    expect(result?.content).toContain("Resume session (1 of 9)");
    expect(result?.content).toContain("❯ Document Tauri reference");
    expect(result?.content).toContain("Type to search · Esc to cancel");
    // Should NOT bleed the `❯ /resume` input line before the picker into the
    // extraction.
    expect(result?.content).not.toContain("❯ /resume");
  });

  it("extracts Claude ResumeSummaryPrompt (long-session warning after /resume)", () => {
    // Claude shows this AFTER selecting an old, large session in the /resume
    // picker: it advises resuming from a summary to save tokens.
    const pane =
      "❯ 为什么 account 的选择框前面有空的距离\n" +
      "\n" +
      "───────────────────────────────────────\n" +
      "  This session is 4h 59m old and 503.4k tokens.\n" +
      "\n" +
      "  Resuming the full session will consume a substantial portion of your usage limits. We recommend\n" +
      "  resuming from a summary.\n" +
      "\n" +
      "  ❯ 1. Resume from summary (recommended)\n" +
      "    2. Resume full session as-is\n" +
      "    3. Don't ask me again\n" +
      "\n" +
      "  Enter to confirm · Esc to cancel\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("ResumeSummaryPrompt");
    expect(result?.content).toContain("This session is 4h 59m old");
    expect(result?.content).toContain("❯ 1. Resume from summary");
    expect(result?.content).toContain("Enter to confirm · Esc to cancel");
    // Must not bleed the prompt input line above into the extraction.
    expect(result?.content).not.toContain("为什么 account");
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

  it("detects a real AskUserQuestion whose footer is followed by a task list, not chrome", () => {
    // Regression guard for the 0.3.9→0.3.14 saga. 0.3.9 added a
    // chrome-anchor band-aid requiring a `─────` line within 4 lines
    // BELOW the "Enter to select" footer (to suppress prose phantoms).
    // But a real Claude picker frames the options with chrome ABOVE the
    // ☐ and in the MIDDLE (the Type-something / Chat-about-this split),
    // while the footer is followed by Claude's task list — NO chrome
    // below it. The guard rejected this live picker and left the user
    // stuck unable to answer. 0.3.14 reverted the guard. This pane is a
    // trimmed real capture from creative-project (@4).
    const realPickerWithTasksBelow =
      "⏺ 项目背景已摸清。P8 范围有几个决策点，一个个来。\n" +
      "───────────────────────────────────────────\n" +
      " ☐ reason 范围\n" +
      "\n" +
      "P8 要 surface 哪些 predict reason？\n" +
      "\n" +
      "❯ 1. 全部四个（插件平价）\n" +
      "  2. 只做 account + taxRate\n" +
      "  3. 只做 counterparty\n" +
      "  4. Type something.\n" +
      "───────────────────────────────────────────\n" +
      "  5. Chat about this\n" +
      "\n" +
      "Enter to select · ↑/↓ to navigate · Esc to cancel\n" +
      "\n" +
      "  3 tasks (0 done, 1 in progress, 2 open)\n" +
      "  ◼ P8 brainstorm: clarify scope\n" +
      "  ◻ P8 brainstorm: present design + write spec\n";
    const result = extractInteractiveContent(realPickerWithTasksBelow);
    expect(result?.name).toBe("AskUserQuestion");
    expect(result?.content).toContain("reason 范围");
    expect(result?.content).toContain("全部四个");
  });

  it("extracts Claude SessionSurvey (data-usage prompt with y/n/d shortcuts)", () => {
    // Real Claude pane during the periodic data-usage survey. Pre-0.3.10
    // this wasn't detected → user sent messages from TG and got silence
    // because Claude was blocked waiting on y/n/d.
    const pane =
      "  最近改了几个仓库的远端分支策略，先确认推送方式：\n" +
      "  1. master\n" +
      "  2. feature branch\n" +
      "\n" +
      "✻ Brewed for 2m 56s · 2 shells still running\n" +
      "\n" +
      "⏺ Can Anthropic look at your session transcript to help us improve Claude Code?\n" +
      "  Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys\n" +
      "  y: Yes    n: No     d: Don't ask again\n" +
      "\n" +
      "─────\n" +
      "❯\n" +
      "─────\n" +
      "  ⏵⏵ bypass permissions on · 2 shells · ← for agents · ↓ to manage\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("SessionSurvey");
    expect(result?.content).toContain("Can Anthropic look at your session transcript");
    expect(result?.content).toContain("y: Yes");
    expect(result?.content).toContain("Don't ask again");
    // Should NOT bleed earlier content (the push-method discussion) into
    // the extracted prompt — that would confuse the TG user about what
    // they're being asked.
    expect(result?.content).not.toContain("master");
    expect(result?.content).not.toContain("feature branch");
  });

  it("does not phantom-match SessionSurvey from prose mentioning the survey", () => {
    // Belt-and-suspenders: even if we mention the survey question in
    // chat (e.g. discussing this very feature), the very distinctive
    // y/n/d bottom regex is what gates the match. Confirm the prose
    // doesn't trigger when bottom isn't present.
    const pane =
      "⏺ When Claude finishes a long session it sometimes asks:\n" +
      "  Can Anthropic look at your session transcript? Helps them improve the product.\n" +
      "  You answer with one of three keys.\n" +
      "─────\n" +
      "❯\n";
    expect(extractInteractiveContent(pane)).toBeNull();
  });

  it("locks onto the latest AskUserQuestion when an older one lingers in scrollback", () => {
    // capturePane now includes scrollback (-S -200). A previously-dismissed
    // picker can sit above the live one. A top-down scan would lock onto the
    // dead picker and ship stale content with a keyboard wired to the live
    // windowId — the parser must scan bottom-up.
    const pane =
      "(some history)\n" +
      "\n" +
      " ☐ Old question: pick one?\n" +
      "Old picker description\n" +
      "❯ 1. Old option A\n" +
      "  2. Old option B\n" +
      "Enter to select · ↑/↓ to navigate · Esc to cancel\n" +
      "─────\n" +
      "\n" +
      "User declined to answer questions\n" +
      "⎿  · Old prompt was dismissed\n" +
      "\n" +
      "(more conversation)\n" +
      "⏺ Now there's a new question\n" +
      "\n" +
      " ☐ New question: pick one?\n" +
      "New picker description\n" +
      "❯ 1. New option X\n" +
      "  2. New option Y\n" +
      "Enter to select · ↑/↓ to navigate · Esc to cancel\n" +
      "─────\n";
    const result = extractInteractiveContent(pane);
    expect(result?.name).toBe("AskUserQuestion");
    expect(result?.content).toContain("New question");
    expect(result?.content).toContain("New option X");
    expect(result?.content).not.toContain("Old question");
    expect(result?.content).not.toContain("Old option A");
    expect(result?.content).not.toContain("declined");
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
