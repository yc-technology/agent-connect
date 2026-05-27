export interface InteractiveUIContent {
  content: string;
  name: string;
}

interface UIPattern {
  name: string;
  top: RegExp[];
  bottom: RegExp[];
  minGap: number;
  // When true, the matched region must be followed (within 4 lines) by a
  // long-dash chrome separator. See `tryExtract` for rationale. Default
  // false; opt-in for patterns whose top/bottom matchers are common in
  // prose (Claude's checkbox-style AskUserQuestion).
  requireChromeBelow?: boolean;
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
    minGap: 1,
    requireChromeBelow: true
  },
  {
    name: "AskUserQuestion",
    top: [/^\s*[☐✔☒]/u],
    bottom: [/^\s*Enter to select/],
    minGap: 1,
    requireChromeBelow: true
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
    // Claude's periodic data-usage survey:
    //   ⏺ Can Anthropic look at your session transcript to help us improve Claude Code?
    //     Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys
    //     y: Yes    n: No     d: Don't ask again
    // Blocks the TUI input row until y/n/d is pressed. Pre-0.3.10 this
    // wasn't surfaced — bot users sent messages from Telegram and got
    // silence because Claude was waiting on the survey. The `d` choice
    // suppresses it permanently for the session.
    //
    // No requireChromeBelow because the question text + the very
    // distinctive `y: Yes ... n: No ... d: Don'?t ask` bottom regex are
    // specific enough that no realistic prose collides.
    name: "SessionSurvey",
    top: [/Can Anthropic look at your session transcript/],
    bottom: [/^\s*y:\s*Yes\s+n:\s*No\s+d:\s*Don'?t ask/i],
    minGap: 1
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
  // Scan bottom-up so we always lock onto the LATEST occurrence of the UI.
  // capturePane includes scrollback, so an older dismissed picker can sit
  // above the live one — a top-down scan would lock onto the stale one and
  // ship dead content (with a keyboard wired to the live windowId — worst of
  // both worlds). Bottom-up means the current on-screen UI always wins.
  //
  // For patterns with multiple `top` regexes (e.g. ResumeSummaryPrompt's
  // two-line header), we resolve each regex independently to its most recent
  // hit, then take the *earliest* of those as topIdx — that way the full
  // multi-line header is preserved without picking up stale pickers above.
  let topIdx: number | null = null;
  let bottomIdx: number | null = null;

  if (pattern.bottom.length > 0) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (pattern.bottom.some((re) => re.test(lines[i] ?? ""))) {
        bottomIdx = i;
        break;
      }
    }
    if (bottomIdx === null) return null;
    const topMatches: number[] = [];
    for (const re of pattern.top) {
      for (let i = bottomIdx - 1; i >= 0; i -= 1) {
        if (re.test(lines[i] ?? "")) {
          topMatches.push(i);
          break;
        }
      }
    }
    if (topMatches.length === 0) return null;
    topIdx = Math.min(...topMatches);
  } else {
    // No bottom marker: most recent top match, then last non-blank line below.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (pattern.top.some((re) => re.test(lines[i] ?? ""))) {
        topIdx = i;
        break;
      }
    }
    if (topIdx === null) return null;
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

  // Chrome-anchor guard for prose-false-positive-prone patterns. The two
  // Claude AskUserQuestion variants (just `☐` checkbox + "Enter to select"
  // footer) match all over plain prose — including a Telegram conversation
  // that happens to be discussing the bot's own picker UI. Without an
  // anchor, every time we talk about pickers in a TG-bound topic, the
  // tmux pane shows Claude's response containing `☐`/"Enter to select"/etc
  // → extractInteractiveContent fires → phantom picker rendered in TG.
  //
  // Real Claude TUI pickers are framed by long-dash chrome (U+2500 ≥5) on
  // BOTH sides. Prose containing the same glyphs has chrome only at the
  // bottom of pane (the input-area chrome), far below. Requiring chrome
  // within `CHROME_PROXIMITY` lines below bottomIdx catches the prose case
  // without breaking real TUI capture.
  //
  // Opt-in per pattern because: Codex's distinctive `Question N/M` +
  // `tab to add notes | enter to submit answer` patterns are specific
  // enough that no realistic prose hits them; ditto Settings /
  // ExitPlanMode / Bash approval / etc. Only the two glyph-based Claude
  // variants need the extra anchor.
  //
  // BAND-AID. This is heuristic-on-heuristic — magic proximity number,
  // assumes chrome layout never changes, hand-curated pattern flag list.
  // The proper fix is event-driven: subscribe to Claude's `Notification`
  // hook (fires when claude is blocked waiting for user input), set a
  // per-window "pending input" flag, and only run extractInteractiveContent
  // when the flag is set. Prose can't trigger phantom pickers if the
  // detection path doesn't run at all. Scheduled for 0.4.0 — see
  // CHANGELOG/0.3.9 entry for rationale on shipping the band-aid first.
  if (pattern.requireChromeBelow) {
    const CHROME_PROXIMITY = 4;
    let chromeNearby = false;
    for (let i = bottomIdx + 1; i < Math.min(lines.length, bottomIdx + 1 + CHROME_PROXIMITY); i += 1) {
      if (LONG_DASH_RE.test(lines[i] ?? "")) {
        chromeNearby = true;
        break;
      }
    }
    if (!chromeNearby) return null;
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
  // Claude's TUI now sandwiches the input row between TWO chrome separators:
  //     [spinner status]
  //     [● rating / supplementary notifications]
  //     ───────────────────  ← chrome 1 (above input)
  //     ❯ <user input echo>
  //     ───────────────────  ← chrome 2 (below input)
  //     [footer mode bar]
  //     [blank padding]
  // The walk-back needs to anchor on chrome 1 (above the input); anchoring on
  // chrome 2 hits the `❯` input line on the very first step backward and
  // breaks before reaching the spinner — leaving Telegram stuck on whatever
  // status was last shown. Widen the search and pick the FIRST chrome found
  // (= the upper one in pane order). When only one chrome is present (older
  // TUI), the same logic still works.
  const searchStart = Math.max(0, lines.length - 15);
  let chromeIdx: number | null = null;

  for (let i = searchStart; i < lines.length; i += 1) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.length >= 20 && [...stripped].every((ch) => ch === "─")) {
      chromeIdx = i;
      break;
    }
  }

  if (chromeIdx === null) return null;

  // Walk back from chrome looking for the spinner-prefixed status line.
  // Claude attaches several kinds of "supplementary" content between the
  // spinner and the chrome that we need to walk past:
  //   - Indented lines: `/compact` progress bar "▰▰▱▱ NN%", "⎿  Tip:"
  //     hints with indented continuations, multi-option rating choices.
  //   - `●`-prefixed system notifications: the periodic
  //     "How is Claude doing this session?" rating prompt, plugin update
  //     banners, etc. These are NOT indented but they are not the
  //     spinner either — without skipping them the walk-back terminates
  //     prematurely and we miss the real spinner above (silent failure:
  //     Telegram sees only the runtime "Thinking..." status forever).
  // Opportunistically harvest a progress percent from skipped lines so it
  // can be appended to the status text.
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
    // Claude system notifications use two visually-similar but DIFFERENT glyphs:
    //   ● U+25CF BLACK CIRCLE          → "How is Claude doing this session?" rating
    //   ⏺ U+23FA BLACK CIRCLE FOR RECORD → "Can Anthropic look at your session transcript?"
    //   ⏺ also prefixes tool-use displays ("⏺ Bash(...)"), but those sit ABOVE the
    //   spinner in the pane order — skipping them here only matters when the
    //   spinner is below them in the walk-back window, which doesn't happen
    //   (spinner is always immediately before chrome).
    if (first === "●" || first === "⏺") continue;
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

  // Top-down scan is intentional: caller is the /usage command handler, which
  // captures the pane immediately after rendering — the latest `Settings: Usage`
  // block is also the first one. A stale block sitting earlier in scrollback
  // would only matter if /usage was re-run quickly without the previous frame
  // scrolling out; flip this to bottom-up if that becomes a real complaint.
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
