import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { InlineKeyboard } from "grammy";
import type { ClaudeSession } from "./session.js";
import {
  CB_DIR_CANCEL,
  CB_DIR_CONFIRM,
  CB_DIR_PAGE,
  CB_DIR_SELECT,
  CB_DIR_UP,
  CB_SESSION_CANCEL,
  CB_SESSION_NEW,
  CB_SESSION_SELECT,
  CB_WIN_BIND,
  CB_WIN_CANCEL,
  CB_WIN_NEW
} from "./callbackData.js";

export const DIRS_PER_PAGE = 6;

export const STATE_KEY = "state";
export const STATE_BROWSING_DIRECTORY = "browsing_directory";
export const STATE_SELECTING_WINDOW = "selecting_window";
export const BROWSE_PATH_KEY = "browse_path";
export const BROWSE_PAGE_KEY = "browse_page";
export const BROWSE_DIRS_KEY = "browse_dirs";
export const UNBOUND_WINDOWS_KEY = "unbound_windows";
export const STATE_SELECTING_SESSION = "selecting_session";
export const SESSIONS_KEY = "cached_sessions";

type UserData = Record<string, unknown> | undefined | null;
type InlineButton = ReturnType<typeof InlineKeyboard.text>;

export interface WindowPickerEntry {
  windowId: string;
  windowName: string;
  cwd: string;
}

export interface DirectoryBrowserOptions {
  showHiddenDirs?: boolean;
  nowMs?: number;
}

export function clearBrowseState(userData: UserData): void {
  if (!userData) return;
  delete userData[STATE_KEY];
  delete userData[BROWSE_PATH_KEY];
  delete userData[BROWSE_PAGE_KEY];
  delete userData[BROWSE_DIRS_KEY];
}

export function clearWindowPickerState(userData: UserData): void {
  if (!userData) return;
  delete userData[STATE_KEY];
  delete userData[UNBOUND_WINDOWS_KEY];
}

export function clearSessionPickerState(userData: UserData): void {
  if (!userData) return;
  delete userData[STATE_KEY];
  delete userData[SESSIONS_KEY];
}

export function buildWindowPicker(
  windows: WindowPickerEntry[]
): { text: string; keyboard: InlineKeyboard; windowIds: string[] } {
  const windowIds = windows.map((window) => window.windowId);
  const lines = [
    "**Bind to Existing Window**\n",
    "These windows are running but not bound to any topic.",
    "Pick one to attach it here, or start a new session.\n"
  ];

  for (const window of windows) {
    lines.push(`• \`${window.windowName}\` — ${displayPath(window.cwd)}`);
  }

  const rows: InlineButton[][] = [];
  for (let i = 0; i < windows.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = 0; j < Math.min(2, windows.length - i); j += 1) {
      const name = windows[i + j]!.windowName;
      row.push(InlineKeyboard.text(`🖥 ${truncateLabel(name, 13)}`, `${CB_WIN_BIND}${i + j}`));
    }
    rows.push(row);
  }

  rows.push([
    InlineKeyboard.text("➕ New Session", CB_WIN_NEW),
    InlineKeyboard.text("Cancel", CB_WIN_CANCEL)
  ]);

  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard(rows),
    windowIds
  };
}

export function buildDirectoryBrowser(
  currentPath: string,
  page = 0,
  options: DirectoryBrowserOptions = {}
): { text: string; keyboard: InlineKeyboard; subdirs: string[]; page: number } {
  let path = resolve(currentPath || process.cwd());
  if (!isDirectory(path)) path = process.cwd();

  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => options.showHiddenDirs || !name.startsWith("."))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    subdirs = [];
  }

  const totalPages = Math.max(1, Math.ceil(subdirs.length / DIRS_PER_PAGE));
  const normalizedPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = normalizedPage * DIRS_PER_PAGE;
  const pageDirs = subdirs.slice(start, start + DIRS_PER_PAGE);

  const rows: InlineButton[][] = [];
  for (let i = 0; i < pageDirs.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = 0; j < Math.min(2, pageDirs.length - i); j += 1) {
      const name = pageDirs[i + j]!;
      row.push(InlineKeyboard.text(`📁 ${truncateLabel(name, 13)}`, `${CB_DIR_SELECT}${start + i + j}`));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav: InlineButton[] = [];
    if (normalizedPage > 0) nav.push(InlineKeyboard.text("◀", `${CB_DIR_PAGE}${normalizedPage - 1}`));
    nav.push(InlineKeyboard.text(`${normalizedPage + 1}/${totalPages}`, "noop"));
    if (normalizedPage < totalPages - 1) {
      nav.push(InlineKeyboard.text("▶", `${CB_DIR_PAGE}${normalizedPage + 1}`));
    }
    rows.push(nav);
  }

  const actions: InlineButton[] = [];
  if (path !== dirname(path)) actions.push(InlineKeyboard.text("..", CB_DIR_UP));
  actions.push(InlineKeyboard.text("Select", CB_DIR_CONFIRM));
  actions.push(InlineKeyboard.text("Cancel", CB_DIR_CANCEL));
  rows.push(actions);

  const current = displayPath(path);
  const text =
    subdirs.length === 0
      ? `**Select Working Directory**\n\nCurrent: \`${current}\`\n\n_(No subdirectories)_`
      : `**Select Working Directory**\n\nCurrent: \`${current}\`\n\nTap a folder to enter, or select current directory`;

  return {
    text,
    keyboard: new InlineKeyboard(rows),
    subdirs,
    page: normalizedPage
  };
}

export function buildSessionPicker(
  sessions: ClaudeSession[],
  options: DirectoryBrowserOptions = {}
): { text: string; keyboard: InlineKeyboard } {
  const lines = ["**Resume Session?**\n", "Existing sessions found in this directory.\n"];
  for (const [index, session] of sessions.entries()) {
    const summary = session.summary.length > 40 ? `${session.summary.slice(0, 40)}…` : session.summary;
    const rel = relativeTime(session.filePath, options.nowMs);
    const timeText = rel ? ` (${rel})` : "";
    lines.push(`${index + 1}. ${summary} — ${session.messageCount} msgs${timeText}`);
  }

  const rows: InlineButton[][] = [];
  for (let i = 0; i < sessions.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = 0; j < Math.min(2, sessions.length - i); j += 1) {
      const session = sessions[i + j]!;
      row.push(InlineKeyboard.text(`▶ ${truncateLabel(session.summary, 15)}`, `${CB_SESSION_SELECT}${i + j}`));
    }
    rows.push(row);
  }

  rows.push([
    InlineKeyboard.text("➕ New Session", CB_SESSION_NEW),
    InlineKeyboard.text("Cancel", CB_SESSION_CANCEL)
  ]);

  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard(rows)
  };
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length >= maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? path.replace(home, "~") : path;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function relativeTime(filePath: string, nowMs = Date.now()): string {
  try {
    const delta = Math.max(0, Math.floor((nowMs - statSync(filePath).mtimeMs) / 1000));
    if (delta < 60) return "just now";
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  } catch {
    return "";
  }
}

export function defaultWindowNameForPath(path: string): string {
  return basename(resolve(path)) || "session";
}
