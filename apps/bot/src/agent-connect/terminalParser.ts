export interface InteractiveUIContent {
  content: string;
  name: string;
}

interface UIPattern {
  name: string;
  top: RegExp[];
  bottom: RegExp[];
  minGap: number;
}

const UI_PATTERNS: UIPattern[] = [
  {
    name: "ExitPlanMode",
    top: [/^\s*Would you like to proceed\?/, /^\s*Claude has written up a plan/],
    bottom: [/^\s*ctrl-g to edit in /, /^\s*Esc to (cancel|exit)/],
    minGap: 2
  },
  {
    name: "AskUserQuestion",
    top: [/^\s*←\s+[☐✔☒]/u],
    bottom: [],
    minGap: 1
  },
  {
    name: "AskUserQuestion",
    top: [/^\s*[☐✔☒]/u],
    bottom: [/^\s*Enter to select/],
    minGap: 1
  },
  {
    name: "PermissionPrompt",
    top: [
      /^\s*Do you want to proceed\?/,
      /^\s*Do you want to make this edit/,
      /^\s*Do you want to create \S/,
      /^\s*Do you want to delete \S/
    ],
    bottom: [/^\s*Esc to cancel/],
    minGap: 2
  },
  {
    name: "PermissionPrompt",
    top: [/^\s*❯\s*1\.\s*Yes/u],
    bottom: [],
    minGap: 2
  },
  {
    name: "BashApproval",
    top: [/^\s*Bash command\s*$/, /^\s*This command requires approval/],
    bottom: [/^\s*Esc to cancel/],
    minGap: 2
  },
  {
    name: "RestoreCheckpoint",
    top: [/^\s*Restore the code/],
    bottom: [/^\s*Enter to continue/],
    minGap: 2
  },
  {
    name: "Settings",
    top: [/^\s*Settings:.*tab to cycle/, /^\s*Select model/],
    bottom: [/Esc to cancel/, /Esc to exit/, /Enter to confirm/, /^\s*Type to filter/],
    minGap: 2
  },
  {
    // Claude `/resume` session picker. Distinctive header `Resume session (N of M)`
    // and a footer mentioning the Ctrl+A / Ctrl+B / Type to search controls.
    // The default Up/Down/Enter/Esc keyboard is enough to navigate; Ctrl+* shortcuts
    // are not reachable from Telegram (acceptable v1).
    name: "ResumeSession",
    top: [/^\s*Resume session\s*\(\d+\s+of\s+\d+\)/],
    bottom: [/Type to search\s*·\s*Esc to cancel/],
    minGap: 2
  },
  {
    // Shown AFTER picking a long-running session in `/resume` — Claude warns
    // about token usage and asks whether to resume from summary, full, or skip.
    // Numbered choices (Resume from summary / Resume full as-is / Don't ask) +
    // standard `Enter to confirm · Esc to cancel` footer.
    name: "ResumeSummaryPrompt",
    top: [
      /^\s*This session is .+ old and .+ tokens\./,
      /^\s*Resuming the full session will consume/
    ],
    bottom: [/^\s*Enter to confirm\s*·\s*Esc to cancel/],
    minGap: 2
  },
  // ─── Codex TUI prompts ───
  // Codex shapes its interactive prompts differently from Claude:
  //   - AskUserQuestion uses a "Question N/M" header + "›" cursor + numbered
  //     options + "tab to add notes | enter to submit answer | esc to interrupt"
  //     footer (instead of Claude's ☐/☑/☒ checkbox glyphs).
  //   - PermissionPrompt asks "Would you like to run the following command?"
  //     and ends with "Press enter to confirm or esc to cancel".
  // Reuses the same logical names so handleInteractiveUi + keyboard layout
  // work unchanged — only the matcher is Codex-specific.
  {
    name: "AskUserQuestion",
    top: [/^\s*Question\s+\d+\/\d+/],
    bottom: [/^\s*tab to add notes\s*\|\s*enter to submit answer/i],
    minGap: 2
  },
  {
    name: "PermissionPrompt",
    top: [
      /^\s*Would you like to run the following command\?/,
      /^\s*Would you like to make the following edits?\?/
    ],
    bottom: [/^\s*Press enter to confirm or esc to cancel/i],
    minGap: 2
  },
  {
    name: "Settings",
    top: [/^\s*Select Model and Effort/, /^\s*Select Approval Mode/],
    bottom: [/^\s*Press enter to confirm or esc to (?:go back|cancel|exit)/i],
    minGap: 2
  }
];

const LONG_DASH_RE = /^─{5,}$/u;
const STATUS_SPINNERS = new Set(["·", "✻", "✽", "✶", "✳", "✢"]);
// Claude `/compact` progress bar — a line of filled/unfilled blocks followed
// by a percent. We splice the percent onto the spinner status so Telegram
// users see "Compacting conversation… 47%" tick up live.
const PROGRESS_BAR_RE = /^\s*[▰▱]+\s+(\d+)\s*%\s*$/u;

function shortenSeparators(text: string): string {
  return text
    .split("\n")
    .map((line) => (LONG_DASH_RE.test(line) ? "─────" : line))
    .join("\n");
}

function tryExtract(lines: string[], pattern: UIPattern): InteractiveUIContent | null {
  let topIdx: number | null = null;
  let bottomIdx: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (topIdx === null) {
      if (pattern.top.some((re) => re.test(line))) {
        topIdx = i;
      }
    } else if (pattern.bottom.length > 0 && pattern.bottom.some((re) => re.test(line))) {
      bottomIdx = i;
      break;
    }
  }

  if (topIdx === null) return null;

  if (pattern.bottom.length === 0) {
    for (let i = lines.length - 1; i > topIdx; i -= 1) {
      if ((lines[i] ?? "").trim()) {
        bottomIdx = i;
        break;
      }
    }
  }

  if (bottomIdx === null || bottomIdx - topIdx < pattern.minGap) {
    return null;
  }

  const content = lines.slice(topIdx, bottomIdx + 1).join("\n").trimEnd();
  return {
    content: shortenSeparators(content),
    name: pattern.name
  };
}

export function extractInteractiveContent(paneText: string): InteractiveUIContent | null {
  if (!paneText) return null;
  const lines = paneText.trim().split("\n");
  for (const pattern of UI_PATTERNS) {
    const result = tryExtract(lines, pattern);
    if (result) return result;
  }
  return null;
}

export function isInteractiveUi(paneText: string): boolean {
  return extractInteractiveContent(paneText) !== null;
}

export function parseStatusLine(paneText: string): string | null {
  if (!paneText) return null;

  const lines = paneText.split("\n");
  let chromeIdx: number | null = null;
  const searchStart = Math.max(0, lines.length - 10);

  for (let i = searchStart; i < lines.length; i += 1) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.length >= 20 && [...stripped].every((ch) => ch === "─")) {
      chromeIdx = i;
      break;
    }
  }

  if (chromeIdx === null) return null;

  // Walk back from chrome looking for the spinner-prefixed status line.
  // Claude attaches supplementary content BELOW the spinner — `/compact`
  // shows "▰▰▱▱ NN%" plus a "⎿ Tip:" hint with an indented continuation,
  // so the spinner line can be 3-4 lines above chrome. Every attachment
  // Claude emits is indented (leading whitespace), so a single skip rule
  // covers them all: opportunistically harvest a progress percent from the
  // skipped lines so it can be appended to the status text.
  let statusText: string | null = null;
  let progressPct: string | null = null;

  for (let i = chromeIdx - 1; i >= Math.max(chromeIdx - 10, 0); i -= 1) {
    const rawLine = lines[i] ?? "";
    if (!rawLine.trim()) continue;

    if (/^\s/.test(rawLine)) {
      const m = rawLine.match(PROGRESS_BAR_RE);
      if (m && !progressPct) progressPct = `${m[1]}%`;
      continue;
    }

    const trimmed = rawLine.trim();
    const first = [...trimmed][0];
    if (first && STATUS_SPINNERS.has(first)) {
      statusText = trimmed.slice(first.length).trim();
    }
    break;
  }

  if (!statusText) return null;
  return progressPct ? `${statusText} ${progressPct}` : statusText;
}

// Claude's "completed step" status line: a past-tense verb + duration, e.g.
// "Cooked for 3s" / "Baked for 1.5s". statusPolling treats matches as
// "already finished" and clears the Telegram status so the next content
// message lands as a fresh send instead of overwriting a stale spinner.
//
// Edge cases the regex must cover:
//   - Accented verbs from Claude's pool: "Sautéed for 17s", "Flambéed for 5s".
//     Use `\p{L}` (Unicode letter), not `[A-Za-z]`.
//   - Multi-unit durations over 1 minute: "Worked for 1m 5s",
//     "Cooked for 2h 13m", "Brewed for 1h 30m 5s". Match one or more
//     `<digits><unit>` tokens (units s|m|h) separated by spaces.
//   - Optional middle-dot side note after the duration:
//     "Brewed for 34s · 1 shell still running" — Claude appends background
//     state with `· <note>` when relevant. Treat the whole line as completed
//     so the status clears.
const DURATION_PART = String.raw`\d+(?:\.\d+)?[smh]`;
const COMPLETED_STATUS_RE = new RegExp(
  String.raw`^\p{L}[\p{L} -]*ed for ${DURATION_PART}(?:\s+${DURATION_PART})*(?:\s*·.*)?$`,
  "u"
);
export function isCompletedStatusLine(statusLine: string): boolean {
  return COMPLETED_STATUS_RE.test(statusLine.trim());
}

export function stripPaneChrome(lines: string[]): string[] {
  const searchStart = Math.max(0, lines.length - 10);
  for (let i = searchStart; i < lines.length; i += 1) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.length >= 20 && [...stripped].every((ch) => ch === "─")) {
      return lines.slice(0, i);
    }
  }
  return lines;
}

export function extractBashOutput(paneText: string, command: string): string | null {
  const lines = stripPaneChrome(paneText.split(/\r?\n/));
  let cmdIdx: number | null = null;
  const matchPrefix = command.slice(0, 10);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.startsWith(`! ${matchPrefix}`) || stripped.startsWith(`!${matchPrefix}`)) {
      cmdIdx = i;
      break;
    }
  }

  if (cmdIdx === null) return null;

  const rawOutput = lines.slice(cmdIdx);
  while (rawOutput.length > 0 && !(rawOutput.at(-1) ?? "").trim()) {
    rawOutput.pop();
  }

  if (rawOutput.length === 0) return null;
  return rawOutput.join("\n").trim();
}

export interface UsageInfo {
  rawText: string;
  parsedLines: string[];
}

export function parseUsageOutput(paneText: string): UsageInfo | null {
  if (!paneText) return null;

  const lines = paneText.trim().split("\n");
  let startIdx: number | null = null;
  let endIdx: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const stripped = (lines[i] ?? "").trim();
    if (startIdx === null) {
      if (stripped.includes("Settings:") && stripped.includes("Usage")) {
        startIdx = i + 1;
      }
    } else if (stripped.startsWith("Esc to")) {
      endIdx = i;
      break;
    }
  }

  if (startIdx === null) return null;
  const end = endIdx ?? lines.length;
  const parsedLines = lines
    .slice(startIdx, end)
    .map((line) => line.trim().replace(/^[\u2580-\u259f\s]+/u, "").trim())
    .filter(Boolean);

  return parsedLines.length > 0 ? { rawText: paneText, parsedLines } : null;
}
