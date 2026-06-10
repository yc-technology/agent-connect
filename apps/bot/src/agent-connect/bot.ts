import { Bot, InputFile, type Context } from "grammy";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BashCaptureManager } from "./bashCapture.js";
import type { AgentType } from "./claudeCommand.js";
import type { Config } from "./config.js";
import {
  CB_DIR_CANCEL,
  CB_DIR_CONFIRM,
  CB_DIR_PAGE,
  CB_DIR_SELECT,
  CB_DIR_UP,
  CB_ASK_DOWN,
  CB_ASK_ENTER,
  CB_ASK_ESC,
  CB_ASK_LEFT,
  CB_ASK_LITERAL_D,
  CB_ASK_LITERAL_N,
  CB_ASK_LITERAL_Y,
  CB_ASK_REFRESH,
  CB_ASK_RIGHT,
  CB_ASK_SPACE,
  CB_ASK_TAB,
  CB_ASK_UP,
  CB_KEYS_PREFIX,
  CB_SCREENSHOT_REFRESH,
  CB_SESSION_CANCEL,
  CB_SESSION_NEW,
  CB_SESSION_SELECT,
  CB_WIN_BIND,
  CB_WIN_CANCEL,
  CB_WIN_NEW
} from "./callbackData.js";
import {
  BROWSE_DIRS_KEY,
  BROWSE_PAGE_KEY,
  BROWSE_PATH_KEY,
  buildDirectoryBrowser,
  buildSessionPicker,
  buildWindowPicker,
  clearBrowseState,
  clearSessionPickerState,
  clearWindowPickerState,
  SESSIONS_KEY,
  STATE_BROWSING_DIRECTORY,
  STATE_KEY,
  STATE_SELECTING_SESSION,
  STATE_SELECTING_WINDOW,
  UNBOUND_WINDOWS_KEY
} from "./directoryBrowser.js";
import { buildHistoryPage, parseHistoryCallbackData, sendHistory } from "./history.js";
import { logger as sharedLogger } from "./logger.js";
import { clearInteractiveMessage, handleInteractiveUi } from "./interactiveUi.js";
import {
  editTextWithFallback,
  replyWithFallback,
  telegramApiFromGrammy,
  type TelegramApiLike
} from "./messageSender.js";
import type { MessageQueueManager } from "./messageQueue.js";
import { textToImage } from "./screenshot.js";
import type { ClaudeSession, SessionManager } from "./session.js";
import { isInteractiveUi, parseStatusLine, parseUsageOutput } from "./terminalParser.js";
import { createGrammyBot } from "./telegramClient.js";
import { isForumThreadId, PRIVATE_CHAT_THREAD_ID } from "./telegramThread.js";
import type { TmuxManager } from "./tmuxManager.js";
import { agentConnectDir, errorMessage } from "./utils.js";

// Directory picker starts at $HOME. Previously this used `process.cwd()`
// which was unpredictable for daemon-mode npm users: if they ran
// `agc start --daemon` from any random shell cwd, the daemon inherited
// that cwd permanently and the browser opened there. Home is the
// stable, predictable starting point — users descend into their
// project tree from a known anchor.
const initialBrowsePath = (): string => homedir();

/**
 * Wrap `ctx.answerCallbackQuery` so a Telegram 400 (commonly "query is too
 * old and response timeout expired or query ID is invalid") doesn't bubble
 * up and kill the grammy runtime. Reported in the wild: a Resume Session
 * callback took >10 minutes to ack because createAndBindWindow ran slow
 * tmux + waitForSessionMapEntry ops BEFORE acking — the late ack threw,
 * the throw was unhandled, and the bot's TG polling stopped. Twelve hours
 * of silence followed.
 *
 * answerCallbackQuery is best-effort ("dismiss the loading spinner on the
 * tapped button" + optional toast). It never carries load-bearing payload.
 * Failing to ack just leaves the button spinner visible briefly. Fine.
 *
 * Pair this with acking EARLY (before any slow work) on callbacks that do
 * heavy lifting — see handleSessionSelectCallback / handleSessionNewCallback.
 */
async function safeAnswerCallback(
  ctx: Pick<Context, "answerCallbackQuery">,
  arg?: string | { text?: string; show_alert?: boolean; url?: string; cache_time?: number }
): Promise<void> {
  try {
    if (arg === undefined) {
      await ctx.answerCallbackQuery();
    } else if (typeof arg === "string") {
      await ctx.answerCallbackQuery(arg);
    } else {
      await ctx.answerCallbackQuery(arg);
    }
  } catch (err) {
    sharedLogger().warn(
      { err: errorMessage(err) },
      "answerCallbackQuery failed (best-effort, ignored)"
    );
  }
}

export const CC_COMMANDS: Record<string, string> = {
  clear: "↗ Clear conversation history",
  compact: "↗ Compact conversation context",
  cost: "↗ Show token/cost usage",
  help: "↗ Show Claude Code help",
  memory: "↗ Edit CLAUDE.md",
  model: "↗ Switch AI model",
  // /resume forwards to Claude; its native TUI picker is the richest source
  // of session metadata (title, last activity, tokens, branch). The picker
  // surfaces through statusPolling → terminalParser ResumeSession pattern
  // → interactiveUi inline keyboard, so no extra Telegram-side UI work.
  // Only useful when the binding's window is alive — forwardCommandHandler
  // detects recovery_pending and emits a redirect-to-/join message instead.
  resume: "↗ Resume a Claude session"
};

export const BOT_COMMANDS = [
  { command: "start", description: "Show welcome message" },
  { command: "history", description: "Message history for this topic" },
  { command: "screenshot", description: "Terminal screenshot with control keys" },
  { command: "esc", description: "Send Escape to interrupt Claude" },
  { command: "kill", description: "Kill window and unbind topic (tries to delete topic)" },
  { command: "usage", description: "Show Claude Code usage remaining" },
  ...Object.entries(CC_COMMANDS).map(([command, description]) => ({ command, description }))
];

const PENDING_THREAD_ID_KEY = "_pending_thread_id";
const PENDING_THREAD_TEXT_KEY = "_pending_thread_text";
const SELECTED_PATH_KEY = "_selected_path";

const SCREENSHOT_KEY_SEND_MAP: Record<string, { key: string; enter: boolean; literal: boolean; label: string }> = {
  up: { key: "Up", enter: false, literal: false, label: "↑" },
  dn: { key: "Down", enter: false, literal: false, label: "↓" },
  lt: { key: "Left", enter: false, literal: false, label: "←" },
  rt: { key: "Right", enter: false, literal: false, label: "→" },
  esc: { key: "Escape", enter: false, literal: false, label: "⎋ Esc" },
  ent: { key: "Enter", enter: false, literal: false, label: "⏎ Enter" },
  spc: { key: "Space", enter: false, literal: false, label: "␣ Space" },
  tab: { key: "Tab", enter: false, literal: false, label: "⇥ Tab" },
  cc: { key: "C-c", enter: false, literal: false, label: "^C" }
};

const INTERACTIVE_KEY_SEND_MAP: Array<{
  prefix: string;
  key: string;
  label: string;
  refresh: boolean;
  clear?: boolean;
  literal?: boolean;
}> = [
  { prefix: CB_ASK_UP, key: "Up", label: "↑", refresh: true },
  { prefix: CB_ASK_DOWN, key: "Down", label: "↓", refresh: true },
  { prefix: CB_ASK_LEFT, key: "Left", label: "←", refresh: true },
  { prefix: CB_ASK_RIGHT, key: "Right", label: "→", refresh: true },
  { prefix: CB_ASK_ENTER, key: "Enter", label: "⏎ Enter", refresh: true },
  { prefix: CB_ASK_SPACE, key: "Space", label: "␣ Space", refresh: true },
  { prefix: CB_ASK_TAB, key: "Tab", label: "⇥ Tab", refresh: true },
  { prefix: CB_ASK_ESC, key: "Escape", label: "⎋ Esc", refresh: false, clear: true },
  // SessionSurvey single-letter shortcuts. `literal: true` so tmux sends
  // the actual character (`tmux send-keys -l y`) rather than interpreting
  // `y` as a named key. `clear: true` because the survey closes after
  // answering and shouldn't keep refreshing a now-stale picker.
  { prefix: CB_ASK_LITERAL_Y, key: "y", label: "✅ Yes", refresh: false, clear: true, literal: true },
  { prefix: CB_ASK_LITERAL_N, key: "n", label: "❌ No", refresh: false, clear: true, literal: true },
  { prefix: CB_ASK_LITERAL_D, key: "d", label: "🚫 Don't ask again", refresh: false, clear: true, literal: true }
];

interface IncomingPhoto {
  file_id: string;
  file_unique_id: string;
}

interface TelegramFileInfo {
  file_path?: string;
}

interface TelegramFileApiLike {
  getFile(fileId: string): Promise<TelegramFileInfo>;
}

interface PhotoContextLike {
  from?: { id?: number };
  msg?: {
    message_id?: number;
    message_thread_id?: number;
    photo?: IncomingPhoto[];
    caption?: string;
  };
  chat?: { id: number; type?: string };
  api: TelegramFileApiLike;
  reply(text: string, options?: Record<string, unknown>): Promise<unknown>;
  replyWithChatAction?(action: "typing"): Promise<unknown>;
}

export interface PhotoHandlerOptions {
  imagesDir?: string;
  now?: () => number;
  downloadPhoto?: (args: {
    api: TelegramFileApiLike;
    botToken: string;
    fileId: string;
    destination: string;
  }) => Promise<void>;
}

export interface BotHandlerOptions {
  api?: TelegramApiLike;
  messageQueue?: Pick<
    MessageQueueManager,
    "clearStatusMsgInfo" | "clearToolMsgIdsForTopic" | "clearLastAssistantMessageId"
  >;
  bashCapture?: Pick<BashCaptureManager, "start" | "cancel" | "cancelAll">;
  stateStore?: BotStateStore;
}

interface TopicContextLike {
  from?: { id?: number } | undefined;
  msg?: {
    message_id?: number;
    message_thread_id?: number;
    forum_topic_edited?: { name?: string | undefined };
  } | undefined;
}

interface KillCommandContextLike extends TopicContextLike {
  chat?: { id: number; type?: string } | undefined;
  api: Pick<Bot["api"], "deleteForumTopic">;
  reply(text: string, options?: Record<string, unknown>): Promise<unknown>;
}

export class BotStateStore {
  private readonly data = new Map<number, Record<string, unknown>>();

  userData(userId: number): Record<string, unknown> {
    const current = this.data.get(userId);
    if (current) return current;
    const created: Record<string, unknown> = {};
    this.data.set(userId, created);
    return created;
  }

  clearUser(userId: number): void {
    this.data.delete(userId);
  }
}

export const defaultBotState = new BotStateStore();

export function isUserAllowed(
  userId: number | undefined,
  config: Pick<Config, "isUserAllowed">
): boolean {
  return userId !== undefined && config.isUserAllowed(userId);
}

export function getThreadId(ctx: {
  msg?: { message_thread_id?: number } | undefined;
  chat?: { type?: string } | undefined;
}): number | null {
  const threadId = ctx.msg?.message_thread_id;
  if (threadId !== undefined && threadId !== 1) return threadId;
  return ctx.chat?.type === "private" ? PRIVATE_CHAT_THREAD_ID : null;
}

function rememberTopicProbeMessage(
  ctx: { msg?: { message_id?: number } | undefined },
  sessionManager: Partial<Pick<SessionManager, "setTopicProbeMessageId">>,
  userId: number,
  threadId: number | null
): void {
  if (!isForumThreadId(threadId)) return;
  const messageId = ctx.msg?.message_id;
  if (typeof messageId !== "number") return;
  sessionManager.setTopicProbeMessageId?.(userId, threadId, messageId);
}

export async function startCommand(
  ctx: Pick<Context, "from" | "reply">,
  config: Pick<Config, "isUserAllowed">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) {
    await replyWithFallback(ctx, "You are not authorized to use this bot.");
    return;
  }

  await replyWithFallback(ctx, "🤖 **Claude Code Monitor**\n\nEach topic is a session. Create a new topic to start.");
}

export async function historyCommand(
  ctx: Pick<Context, "from" | "msg" | "reply">,
  config: Pick<Config, "isUserAllowed" | "showUserMessages">,
  sessionManager: Pick<
    SessionManager,
    "resolveWindowForThread" | "getDisplayName" | "getRecentMessages" | "updateUserWindowOffset"
  >
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;

  const threadId = getThreadId(ctx);
  const windowId = sessionManager.resolveWindowForThread(ctx.from!.id, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "❌ No session bound to this topic.");
    return;
  }

  await sendHistory(ctx, sessionManager, config, windowId);
}

export async function historyCallbackHandler(
  ctx: Pick<Context, "callbackQuery" | "editMessageText" | "answerCallbackQuery">,
  config: Pick<Config, "showUserMessages">,
  sessionManager: Pick<SessionManager, "getDisplayName" | "getRecentMessages">,
  tmuxManager: Pick<TmuxManager, "findWindowById">
): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parsed = parseHistoryCallbackData(data);
  if (!parsed) {
    await safeAnswerCallback(ctx, "Invalid data");
    return;
  }

  const window = await tmuxManager.findWindowById(parsed.windowId);
  if (!window) {
    await editTextWithFallback(ctx, "Window no longer exists.");
    await safeAnswerCallback(ctx, "Window no longer exists");
    return;
  }

  const page = await buildHistoryPage(sessionManager, config, parsed.windowId, {
    offset: parsed.offset,
    startByte: parsed.startByte,
    endByte: parsed.endByte
  });
  await editTextWithFallback(ctx, page.text, page.keyboard ? { reply_markup: page.keyboard } : undefined);
  await safeAnswerCallback(ctx, "Page updated");
}

export async function statusCommand(
  ctx: Pick<Context, "from" | "msg" | "reply">,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<
    SessionManager,
    "getWindowForThread" | "getDisplayName" | "getSessionByWindow" | "getLastEvent"
  >,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;

  const threadId = getThreadId(ctx);
  if (threadId === null) {
    await replyWithFallback(ctx, "❌ This command only works in a topic.");
    return;
  }
  const userId = ctx.from!.id!;
  const windowId = sessionManager.getWindowForThread(userId, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "❌ This topic is not bound to any window.");
    return;
  }

  const window = await tmuxManager.findWindowById(windowId);
  const session = sessionManager.getSessionByWindow(windowId);
  const lastEvent = sessionManager.getLastEvent(windowId);
  const displayName = sessionManager.getDisplayName(windowId);

  const lines: string[] = [];
  lines.push(`🪟 ${windowId} · ${displayName}`);
  if (window?.cwd) {
    lines.push(`📁 ${window.cwd}`);
  } else if (!window) {
    lines.push(`⚠️  Window ${windowId} not found in tmux (may have been killed)`);
  }
  if (session) {
    const shortId = session.session_id.slice(0, 13) + "…";
    const tags = [session.agent_type, session.source].filter(Boolean).join(", ");
    lines.push(`🆔 ${shortId}${tags ? ` (${tags})` : ""}`);
  }
  if (lastEvent) {
    const ageSec = Math.round((Date.now() - lastEvent.at) / 1000);
    lines.push(`⏱  ${lastEvent.event} · ${ageSec}s ago`);
  } else if (session) {
    lines.push(`⏱  no hook event received yet`);
  }
  if (window) {
    const paneText = await tmuxManager.capturePane(window.windowId);
    const statusLine = paneText ? parseStatusLine(paneText) : null;
    if (statusLine) {
      lines.push(`📡 ${statusLine}`);
    }
  }
  if (session?.transcript_path && typeof session.last_byte_offset === "number") {
    lines.push(`📦 ${session.last_byte_offset.toLocaleString()} bytes delivered`);
  }

  await replyWithFallback(ctx, lines.join("\n"));
}

export async function escCommand(
  ctx: Pick<Context, "from" | "msg" | "reply">,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<SessionManager, "resolveWindowForThread" | "getDisplayName">,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "sendKeys">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;

  const threadId = getThreadId(ctx);
  const windowId = sessionManager.resolveWindowForThread(ctx.from!.id, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "❌ No session bound to this topic.");
    return;
  }

  const window = await tmuxManager.findWindowById(windowId);
  if (!window) {
    await replyWithFallback(ctx, `❌ Window '${sessionManager.getDisplayName(windowId)}' no longer exists.`);
    return;
  }

  await tmuxManager.sendKeys(window.windowId, "Escape", { enter: false, literal: false });
  await replyWithFallback(ctx, "⎋ Sent Escape");
}

export async function killCommand(
  ctx: KillCommandContextLike,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<SessionManager, "getWindowForThread" | "getDisplayName" | "unbindThread" | "resolveChatId">,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "killWindow">,
  options: BotHandlerOptions = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;

  const userId = ctx.from!.id!;
  const threadId = getThreadId(ctx);
  if (threadId === null) {
    await replyWithFallback(ctx, "❌ This command only works in a topic.");
    return;
  }

  const windowId = sessionManager.getWindowForThread(userId, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "❌ No session bound to this topic.");
    return;
  }

  const display = sessionManager.getDisplayName(windowId);
  const window = await tmuxManager.findWindowById(windowId);
  if (window) {
    await tmuxManager.killWindow(window.windowId);
  }
  sessionManager.unbindThread(userId, threadId);
  await clearTopicState(userId, threadId, {
    ...options,
    routing: sessionManager
  });

  if ((ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") && ctx.chat.id) {
    try {
      await ctx.api.deleteForumTopic(ctx.chat.id, threadId);
      return;
    } catch {
      // If Telegram refuses deletion due to permissions, still report the killed tmux session.
    }
  }

  await replyWithFallback(ctx, `✅ Killed window '${display}' and unbound this topic.`);
}

export function buildScreenshotKeyboard(windowId: string) {
  const button = (label: string, keyId: string) => ({
    text: label,
    callback_data: `${CB_KEYS_PREFIX}${keyId}:${windowId}`.slice(0, 64)
  });

  return {
    inline_keyboard: [
      [button("␣ Space", "spc"), button("↑", "up"), button("⇥ Tab", "tab")],
      [button("←", "lt"), button("↓", "dn"), button("→", "rt")],
      [button("⎋ Esc", "esc"), button("^C", "cc"), button("⏎ Enter", "ent")],
      [
        {
          text: "🔄 Refresh",
          callback_data: `${CB_SCREENSHOT_REFRESH}${windowId}`.slice(0, 64)
        }
      ]
    ]
  };
}

export async function screenshotCommand(
  ctx: Pick<Context, "from" | "msg" | "reply" | "replyWithDocument">,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<SessionManager, "resolveWindowForThread" | "getDisplayName">,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;

  const threadId = getThreadId(ctx);
  const windowId = sessionManager.resolveWindowForThread(ctx.from!.id, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "❌ No session bound to this topic.");
    return;
  }

  const window = await tmuxManager.findWindowById(windowId);
  if (!window) {
    await replyWithFallback(ctx, `❌ Window '${sessionManager.getDisplayName(windowId)}' no longer exists.`);
    return;
  }

  const paneText = await tmuxManager.capturePane(window.windowId, true);
  if (!paneText) {
    await replyWithFallback(ctx, "❌ Failed to capture pane content.");
    return;
  }

  const png = await textToImage(paneText, { withAnsi: true });
  await ctx.replyWithDocument(new InputFile(png, "screenshot.png"), {
    reply_markup: buildScreenshotKeyboard(windowId)
  });
}

export async function usageCommand(
  ctx: Pick<Context, "from" | "msg" | "reply">,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<SessionManager, "resolveWindowForThread">,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "sendKeys" | "capturePane">,
  options: { renderDelayMs?: number } = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;

  const threadId = getThreadId(ctx);
  const windowId = sessionManager.resolveWindowForThread(ctx.from!.id, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "No session bound to this topic.");
    return;
  }

  const window = await tmuxManager.findWindowById(windowId);
  if (!window) {
    await replyWithFallback(ctx, `Window '${windowId}' no longer exists.`);
    return;
  }

  await tmuxManager.sendKeys(window.windowId, "/usage");
  await sleep(options.renderDelayMs ?? 2000);
  const paneText = await tmuxManager.capturePane(window.windowId);
  await tmuxManager.sendKeys(window.windowId, "Escape", { enter: false, literal: false });

  if (!paneText) {
    await replyWithFallback(ctx, "Failed to capture usage info.");
    return;
  }

  await replyWithFallback(ctx, formatUsageReply(paneText));
}

export async function forwardCommandHandler(
  ctx: Pick<Context, "from" | "msg" | "chat" | "reply">,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<
    SessionManager,
    "setGroupChatId" | "resolveWindowForThread" | "getDisplayName" | "sendToWindow" | "clearWindowSession"
  > &
    Partial<Pick<SessionManager, "setTopicProbeMessageId" | "getRecoveryAnchor">>,
  tmuxManager: Pick<TmuxManager, "findWindowById">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;
  if (!ctx.msg?.text) return;

  const threadId = getThreadId(ctx);
  if ((ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") && isForumThreadId(threadId)) {
    sessionManager.setGroupChatId(ctx.from!.id, threadId, ctx.chat.id);
  }
  rememberTopicProbeMessage(ctx, sessionManager, ctx.from!.id, threadId);

  const command = ctx.msg.text.split("@")[0] ?? ctx.msg.text;
  const windowId = sessionManager.resolveWindowForThread(ctx.from!.id, threadId);
  if (!windowId) {
    // recovery_pending: the binding row is preserved (so the soft-deleted
    // last_session_id is still on disk) but window_id is NULL — Claude has
    // no live window to receive a forwarded slash command. Tell the user
    // exactly how to recover instead of the generic "No session bound".
    const anchor =
      threadId !== null && sessionManager.getRecoveryAnchor
        ? sessionManager.getRecoveryAnchor(ctx.from!.id, threadId)
        : null;
    if (anchor) {
      await replyWithFallback(
        ctx,
        `🔄 This topic is awaiting recovery (previous session: ${anchor.slice(0, 8)}…).\n` +
          `Send any plain text message in this topic to re-attach — the resume picker will default to that session.`
      );
    } else {
      await replyWithFallback(ctx, "❌ No session bound to this topic.");
    }
    return;
  }

  const window = await tmuxManager.findWindowById(windowId);
  if (!window) {
    await replyWithFallback(ctx, `❌ Window '${sessionManager.getDisplayName(windowId)}' no longer exists.`);
    return;
  }

  const display = sessionManager.getDisplayName(windowId);
  const [success, message] = await sessionManager.sendToWindow(windowId, command);
  if (!success) {
    await replyWithFallback(ctx, `❌ ${message}`);
    return;
  }

  await replyWithFallback(ctx, `⚡ [${display}] Sent: ${command}`);
  if (command.trim().toLowerCase() === "/clear") {
    sessionManager.clearWindowSession(windowId);
  }
}

export async function unsupportedContentHandler(
  ctx: Pick<Context, "from" | "reply">,
  config: Pick<Config, "isUserAllowed">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;
  await replyWithFallback(
    ctx,
    "⚠ Only text and photo messages are supported right now. Stickers, video, voice, and other media cannot be forwarded to Claude Code."
  );
}

export async function textMessageHandler(
  ctx: Pick<Context, "from" | "msg" | "chat" | "reply">,
  config: Pick<Config, "isUserAllowed" | "showHiddenDirs" | "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "setGroupChatId"
    | "getWindowForThread"
    | "iterThreadBindings"
    | "getDisplayName"
    | "unbindThread"
    | "sendToWindow"
    | "getSessionByWindow"
  > &
    Partial<
      Pick<
        SessionManager,
        | "setTopicProbeMessageId"
        | "bindThread"
        | "waitForSessionMapEntry"
        | "getRecoveryInfo"
        | "deleteWindow"
      >
    >,
  tmuxManager: Pick<TmuxManager, "listWindows" | "findWindowById"> &
    Partial<Pick<TmuxManager, "createWindow" | "capturePane" | "sendKeys">>,
  stateStore = defaultBotState,
  options: BotHandlerOptions = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) {
    await replyWithFallback(ctx, "You are not authorized to use this bot.");
    return;
  }
  if (!ctx.msg?.text) return;

  const userId = ctx.from!.id;
  const threadId = getThreadId(ctx);
  if ((ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") && isForumThreadId(threadId)) {
    sessionManager.setGroupChatId(userId, threadId, ctx.chat.id);
  }
  rememberTopicProbeMessage(ctx, sessionManager, userId, threadId);

  const userData = stateStore.userData(userId);
  if (shouldBlockTextForPicker(userData, threadId, STATE_SELECTING_WINDOW)) {
    await replyWithFallback(ctx, "Please use the window picker above, or tap Cancel.");
    return;
  }
  if (clearStalePickerState(userData, threadId, STATE_SELECTING_WINDOW)) {
    clearWindowPickerState(userData);
  }

  if (shouldBlockTextForPicker(userData, threadId, STATE_BROWSING_DIRECTORY)) {
    await replyWithFallback(ctx, "Please use the directory browser above, or tap Cancel.");
    return;
  }
  if (clearStalePickerState(userData, threadId, STATE_BROWSING_DIRECTORY)) {
    clearBrowseState(userData);
  }

  if (shouldBlockTextForPicker(userData, threadId, STATE_SELECTING_SESSION)) {
    await replyWithFallback(ctx, "Please use the session picker above, or tap Cancel.");
    return;
  }
  if (clearStalePickerState(userData, threadId, STATE_SELECTING_SESSION)) {
    clearSessionPickerState(userData);
    delete userData[SELECTED_PATH_KEY];
  }

  if (threadId === null) {
    await replyWithFallback(ctx, "❌ Please use a named topic, or DM the bot directly.");
    return;
  }

  const boundWindowId = sessionManager.getWindowForThread(userId, threadId);
  if (!boundWindowId) {
    // Lazy auto-resume (the reboot case). statusPolling soft-deletes the binding
    // on its first post-reboot tick — nulling window_id and cascade-deleting the
    // sessions row — so by the time a message arrives the topic is here, in the
    // unbound branch, in recovery_pending state. The cwd + session_id survive on
    // the binding (last_cwd / last_session_id), so resume transparently instead
    // of dumping the user into the directory picker.
    const recovery = sessionManager.getRecoveryInfo?.(userId, threadId);
    if (recovery) {
      const resumed = await resumeOntoNewWindow(
        ctx,
        userId,
        threadId,
        recovery.cwd,
        recovery.sessionId,
        ctx.msg.text,
        sessionManager,
        tmuxManager,
        options
      );
      if (resumed) return;
    }

    const windows = await tmuxManager.listWindows();
    const boundIds = new Set([...sessionManager.iterThreadBindings()].map(([, , windowId]) => windowId));
    // Only offer windows that the bot has actually registered as managed
    // (i.e. a SessionStart hook fired for them and a row exists in the
    // sessions table). Without this, random user-owned tmux windows
    // (zsh, vim, dev servers) showed up as bind candidates — the
    // reporter's deployment had two bare zsh windows the picker was
    // happily offering. Binding to a non-agent window means our
    // sendKeys deposits the user's Telegram text into zsh stdin, which
    // is at best confusing and at worst destructive.
    //
    // We use sessions-table presence, not `pane_current_command`,
    // because Claude Code sets its own process title to its version
    // string (e.g. "2.1.147") — there's no reliable command-name
    // allowlist to match on across versions/agents.
    const unbound = windows
      .filter((window) => !boundIds.has(window.windowId))
      .filter((window) => sessionManager.getSessionByWindow(window.windowId) !== null)
      .map((window) => ({
        windowId: window.windowId,
        windowName: window.windowName,
        cwd: window.cwd
      }));

    userData[PENDING_THREAD_ID_KEY] = threadId;
    userData[PENDING_THREAD_TEXT_KEY] = ctx.msg.text;

    if (unbound.length > 0) {
      const picker = buildWindowPicker(unbound);
      userData[STATE_KEY] = STATE_SELECTING_WINDOW;
      userData[UNBOUND_WINDOWS_KEY] = picker.windowIds;
      await replyWithFallback(ctx, picker.text, { reply_markup: picker.keyboard });
      return;
    }

    const browser = buildDirectoryBrowser(initialBrowsePath(), 0, { showHiddenDirs: config.showHiddenDirs });
    userData[STATE_KEY] = STATE_BROWSING_DIRECTORY;
    userData[BROWSE_PATH_KEY] = resolve(initialBrowsePath());
    userData[BROWSE_PAGE_KEY] = browser.page;
    userData[BROWSE_DIRS_KEY] = browser.subdirs;
    await replyWithFallback(ctx, browser.text, { reply_markup: browser.keyboard });
    return;
  }

  const window = await tmuxManager.findWindowById(boundWindowId);
  if (!window) {
    // Lazy auto-resume. The bound tmux window is gone — the dominant cause is
    // a machine reboot: the tmux server restarted and reassigned window ids,
    // so the stored `@N` no longer exists. The sessions row survives the
    // reboot and still carries the cwd + session_id, so we can transparently
    // recreate the window with `claude --resume <id>`, rebind the topic to the
    // new window, and forward this very message — instead of dropping the
    // binding and forcing the user to start over (the old behavior, kept as a
    // fallback below when there's no anchor to resume from).
    const resumed = await tryResumeBoundWindow(
      ctx,
      userId,
      threadId,
      boundWindowId,
      ctx.msg.text,
      sessionManager,
      tmuxManager,
      options
    );
    if (resumed) return;

    const display = sessionManager.getDisplayName(boundWindowId);
    sessionManager.unbindThread(userId, threadId);
    await replyWithFallback(ctx, `❌ Window '${display}' no longer exists. Binding removed.\nSend a message to start a new session.`);
    return;
  }

  // A TUI picker (/model, AskUserQuestion, a permission prompt…) may be open
  // in this pane. Plain text sendKeys'd now is swallowed by the picker as
  // keystrokes — and the trailing Enter confirms whatever item is highlighted
  // (a /model picker twice auto-selected a model this way while the user's
  // message vanished). Worse, permission prompts react to bare y/n/digit
  // keys, so leaked text can self-approve an action.
  //
  // Always check a FRESH capture; do NOT gate on interactiveModes. The mode
  // flag is written by statusPolling up to one poll tick (~2s) AFTER the
  // picker renders, so a message racing the first tick — the common case:
  // "/model" and the next sentence sent back-to-back — would bypass a
  // flag-gated guard entirely and feed the picker. One tmux capture per
  // inbound message is noise compared to the sendKeys round-trip.
  if (tmuxManager.capturePane) {
    const paneText = await tmuxManager.capturePane(boundWindowId);
    if (paneText && isInteractiveUi(paneText)) {
      // Escape hatch for pickers that legitimately take typed input (the
      // AskUserQuestion "Other" field, /model's filter): a leading ">" types
      // the rest into the pane WITHOUT Enter, so nothing auto-confirms; the
      // user finishes with the ⏎ button on the picker keyboard.
      const passthrough = ctx.msg.text.startsWith(">") ? ctx.msg.text.slice(1).replace(/^ /, "") : "";
      if (passthrough && tmuxManager.sendKeys) {
        await tmuxManager.sendKeys(boundWindowId, passthrough, { enter: false, literal: true });
        await replyWithFallback(ctx, "⌨️ Typed into the picker (no Enter). Tap ⏎ above to confirm, or Esc to cancel.");
        return;
      }
      await replyWithFallback(
        ctx,
        '⚠️ An interactive picker is open in the terminal — message not sent (the picker would swallow it as keystrokes). Use the buttons above to answer or dismiss it, or resend starting with ">" to type into the picker.'
      );
      return;
    }
  }

  options.bashCapture?.cancel(userId, threadId);
  const [success, message] = await sessionManager.sendToWindow(boundWindowId, ctx.msg.text);
  if (!success) {
    await replyWithFallback(ctx, `❌ ${message}`);
    return;
  }

  if (ctx.msg.text.startsWith("!") && ctx.msg.text.length > 1) {
    options.bashCapture?.start(userId, threadId, boundWindowId, ctx.msg.text.slice(1));
  }
}

export async function photoMessageHandler(
  ctx: PhotoContextLike,
  config: Pick<Config, "isUserAllowed" | "telegramBotToken"> & Partial<Pick<Config, "configDir">>,
  sessionManager: Pick<
    SessionManager,
    "setGroupChatId" | "getWindowForThread" | "getDisplayName" | "unbindThread" | "sendToWindow"
  > &
    Partial<Pick<SessionManager, "setTopicProbeMessageId">>,
  tmuxManager: Pick<TmuxManager, "findWindowById"> & Partial<Pick<TmuxManager, "capturePane">>,
  options: PhotoHandlerOptions = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) {
    await replyWithFallback(ctx, "You are not authorized to use this bot.");
    return;
  }

  const photos = ctx.msg?.photo;
  if (!photos?.length) return;

  const userId = ctx.from!.id!;
  const threadId = getThreadId(ctx);
  if ((ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") && threadId !== null) {
    sessionManager.setGroupChatId(userId, threadId, ctx.chat.id);
  }
  rememberTopicProbeMessage(ctx, sessionManager, userId, threadId);

  if (threadId === null) {
    await replyWithFallback(ctx, "❌ Please use a named topic, or DM the bot directly.");
    return;
  }

  const windowId = sessionManager.getWindowForThread(userId, threadId);
  if (!windowId) {
    await replyWithFallback(ctx, "❌ No session bound to this topic. Send a text message first to create one.");
    return;
  }

  const window = await tmuxManager.findWindowById(windowId);
  if (!window) {
    const display = sessionManager.getDisplayName(windowId);
    sessionManager.unbindThread(userId, threadId);
    await replyWithFallback(ctx, `❌ Window '${display}' no longer exists. Binding removed.\nSend a message to start a new session.`);
    return;
  }

  // Same guard as textMessageHandler: with a TUI picker open, the
  // "(image attached: …)" text would be swallowed as picker keystrokes and
  // its Enter would confirm the highlighted item. Fresh capture, not the
  // interactiveModes flag — see the text handler for the race. No
  // passthrough for photos — there's no sensible way to type an image path
  // into a picker field.
  if (tmuxManager.capturePane) {
    const paneText = await tmuxManager.capturePane(windowId);
    if (paneText && isInteractiveUi(paneText)) {
      await replyWithFallback(
        ctx,
        "⚠️ An interactive picker is open in the terminal — image not sent. Use the buttons above to answer or dismiss it, then resend."
      );
      return;
    }
  }

  const photo = photos[photos.length - 1]!;
  const imagesDir = options.imagesDir ?? join(config.configDir ?? agentConnectDir(), "images");
  const timestamp = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const fileName = `${timestamp}_${sanitizePhotoId(photo.file_unique_id)}.jpg`;
  const filePath = join(imagesDir, fileName);

  try {
    await (options.downloadPhoto ?? downloadTelegramPhoto)({
      api: ctx.api,
      botToken: config.telegramBotToken,
      fileId: photo.file_id,
      destination: filePath
    });
  } catch (error) {
    await replyWithFallback(ctx, `❌ Failed to download image: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const caption = ctx.msg?.caption ?? "";
  const textToSend = caption ? `${caption}\n\n(image attached: ${filePath})` : `(image attached: ${filePath})`;

  await ctx.replyWithChatAction?.("typing");
  const [success, message] = await sessionManager.sendToWindow(windowId, textToSend);
  if (!success) {
    await replyWithFallback(ctx, `❌ ${message}`);
    return;
  }

  await replyWithFallback(ctx, "📷 Image sent to Claude Code.");
}

export async function clearTopicState(
  userId: number,
  threadId: number,
  deps: BotHandlerOptions & { routing?: Pick<SessionManager, "resolveChatId"> } = {}
): Promise<void> {
  deps.messageQueue?.clearStatusMsgInfo(userId, threadId);
  deps.messageQueue?.clearToolMsgIdsForTopic(userId, threadId);
  deps.messageQueue?.clearLastAssistantMessageId(userId, threadId);
  await clearInteractiveMessage(deps.api && deps.routing ? { api: deps.api, routing: deps.routing } : null, userId, threadId);

  const userData = deps.stateStore?.userData(userId);
  if (userData?.[PENDING_THREAD_ID_KEY] === threadId) {
    deletePendingText(userData);
  }
}

export async function topicClosedHandler(
  ctx: TopicContextLike,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<
    SessionManager,
    "getWindowForThread" | "getDisplayName" | "unbindThread" | "resolveChatId"
  >,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "killWindow">,
  options: BotHandlerOptions = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;
  const userId = ctx.from!.id!;
  const threadId = getThreadId(ctx);
  if (threadId === null) return;

  const windowId = sessionManager.getWindowForThread(userId, threadId);
  if (!windowId) return;

  const window = await tmuxManager.findWindowById(windowId);
  if (window) {
    await tmuxManager.killWindow(window.windowId);
  }
  sessionManager.unbindThread(userId, threadId);
  await clearTopicState(userId, threadId, {
    ...options,
    routing: sessionManager
  });
}

export async function topicEditedHandler(
  ctx: TopicContextLike,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<SessionManager, "getWindowForThread" | "getDisplayName" | "updateDisplayName">,
  tmuxManager: Pick<TmuxManager, "renameWindow">
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) return;
  const newName = ctx.msg?.forum_topic_edited?.name;
  if (typeof newName !== "string") return;

  const userId = ctx.from!.id!;
  const threadId = getThreadId(ctx);
  if (threadId === null) return;

  const windowId = sessionManager.getWindowForThread(userId, threadId);
  if (!windowId) return;

  await tmuxManager.renameWindow(windowId, newName);
  sessionManager.updateDisplayName(windowId, newName);
}

export async function pickerCallbackHandler(
  ctx: Pick<Context, "from" | "msg" | "chat" | "callbackQuery" | "editMessageText" | "answerCallbackQuery" | "reply">,
  config: Pick<Config, "isUserAllowed" | "showHiddenDirs" | "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "setGroupChatId"
    | "bindThread"
    | "listSessionsForDirectory"
    | "waitForSessionMapEntry"
    | "getWindowState"
    | "saveState"
    | "sendToWindow"
    | "getRecoveryAnchor"
  > &
    Partial<Pick<SessionManager, "setTopicProbeMessageId">>,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "createWindow">,
  stateStore = defaultBotState
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) {
    await safeAnswerCallback(ctx, "Not authorized");
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  if (data === "noop") {
    await safeAnswerCallback(ctx);
    return;
  }

  const userId = ctx.from!.id;
  const threadId = getThreadId(ctx);
  if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
    sessionManager.setGroupChatId(userId, threadId, ctx.chat.id);
  }
  rememberTopicProbeMessage(ctx, sessionManager, userId, threadId);
  const userData = stateStore.userData(userId);

  if (data.startsWith(CB_WIN_BIND)) {
    await handleWindowBindCallback(ctx, userData, userId, threadId, data, sessionManager, tmuxManager);
    return;
  }
  if (data === CB_WIN_NEW) {
    await handleWindowNewCallback(ctx, userData, threadId, config);
    return;
  }
  if (data === CB_WIN_CANCEL) {
    await cancelPicker(ctx, userData, threadId, clearWindowPickerState);
    return;
  }

  if (data.startsWith(CB_DIR_SELECT)) {
    await handleDirectorySelectCallback(ctx, userData, threadId, data, config);
    return;
  }
  if (data === CB_DIR_UP) {
    await handleDirectoryUpCallback(ctx, userData, threadId, config);
    return;
  }
  if (data.startsWith(CB_DIR_PAGE)) {
    await handleDirectoryPageCallback(ctx, userData, threadId, data, config);
    return;
  }
  if (data === CB_DIR_CONFIRM) {
    await handleDirectoryConfirmCallback(ctx, userData, userId, threadId, config, sessionManager, tmuxManager);
    return;
  }
  if (data === CB_DIR_CANCEL) {
    await cancelPicker(ctx, userData, threadId, clearBrowseState);
    return;
  }

  if (data.startsWith(CB_SESSION_SELECT)) {
    await handleSessionSelectCallback(ctx, userData, userId, threadId, data, config, sessionManager, tmuxManager);
    return;
  }
  if (data === CB_SESSION_NEW) {
    await handleSessionNewCallback(ctx, userData, userId, threadId, config, sessionManager, tmuxManager);
    return;
  }
  if (data === CB_SESSION_CANCEL) {
    await cancelPicker(ctx, userData, threadId, clearSessionPickerState, () => {
      delete userData[SELECTED_PATH_KEY];
    });
  }
}

export async function screenshotCallbackHandler(
  ctx: Pick<Context, "from" | "callbackQuery" | "editMessageMedia" | "answerCallbackQuery">,
  config: Pick<Config, "isUserAllowed">,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane" | "sendKeys">,
  options: { refreshDelayMs?: number } = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) {
    await safeAnswerCallback(ctx, "Not authorized");
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  if (data.startsWith(CB_SCREENSHOT_REFRESH)) {
    const windowId = data.slice(CB_SCREENSHOT_REFRESH.length);
    const refreshed = await refreshScreenshotMessage(ctx, windowId, tmuxManager);
    await safeAnswerCallback(ctx, refreshed ? "Refreshed" : { text: "Failed to refresh", show_alert: true });
    return;
  }

  if (data.startsWith(CB_KEYS_PREFIX)) {
    const parsed = parseScreenshotKeyCallback(data);
    if (!parsed) {
      await safeAnswerCallback(ctx, "Invalid data");
      return;
    }

    const keyInfo = SCREENSHOT_KEY_SEND_MAP[parsed.keyId];
    if (!keyInfo) {
      await safeAnswerCallback(ctx, "Unknown key");
      return;
    }

    const window = await tmuxManager.findWindowById(parsed.windowId);
    if (!window) {
      await safeAnswerCallback(ctx, { text: "Window not found", show_alert: true });
      return;
    }

    await tmuxManager.sendKeys(window.windowId, keyInfo.key, {
      enter: keyInfo.enter,
      literal: keyInfo.literal
    });
    await safeAnswerCallback(ctx, keyInfo.label);
    await sleep(options.refreshDelayMs ?? 500);
    await refreshScreenshotMessage(ctx, parsed.windowId, tmuxManager);
  }
}

export async function interactiveCallbackHandler(
  ctx: Pick<Context, "from" | "msg" | "callbackQuery" | "answerCallbackQuery">,
  config: Pick<Config, "isUserAllowed">,
  sessionManager: Pick<SessionManager, "resolveChatId">,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane" | "sendKeys">,
  api = telegramApiFromGrammy({ api: (ctx as Context).api }),
  options: { refreshDelayMs?: number } = {}
): Promise<void> {
  if (!isUserAllowed(ctx.from?.id, config)) {
    await safeAnswerCallback(ctx, "Not authorized");
    return;
  }

  const userId = ctx.from!.id;
  const threadId = getThreadId(ctx);
  const data = ctx.callbackQuery?.data ?? "";

  if (data.startsWith(CB_ASK_REFRESH)) {
    const windowId = data.slice(CB_ASK_REFRESH.length);
    await handleInteractiveUi({ api, routing: sessionManager, tmuxManager }, userId, windowId, threadId);
    await safeAnswerCallback(ctx, "🔄");
    return;
  }

  const action = INTERACTIVE_KEY_SEND_MAP.find((candidate) => data.startsWith(candidate.prefix));
  if (!action) {
    await safeAnswerCallback(ctx, "Invalid data");
    return;
  }

  const windowId = data.slice(action.prefix.length);
  const window = await tmuxManager.findWindowById(windowId);
  if (!window) {
    await safeAnswerCallback(ctx, { text: "Window not found", show_alert: true });
    return;
  }

  await tmuxManager.sendKeys(window.windowId, action.key, { enter: false, literal: action.literal ?? false });
  if (action.clear) {
    await clearInteractiveMessage({ api, routing: sessionManager }, userId, threadId);
  } else if (action.refresh) {
    await sleep(options.refreshDelayMs ?? 500);
    await handleInteractiveUi({ api, routing: sessionManager, tmuxManager }, userId, windowId, threadId);
  }
  await safeAnswerCallback(ctx, action.label);
}

export function formatUsageReply(paneText: string): string {
  const usage = parseUsageOutput(paneText);
  if (usage?.parsedLines.length) {
    return `\`\`\`\n${usage.parsedLines.join("\n")}\n\`\`\``;
  }

  const trimmed = paneText.trim();
  const body = trimmed.length > 3000 ? `${trimmed.slice(0, 3000)}\n... (truncated)` : trimmed;
  return `\`\`\`\n${body}\n\`\`\``;
}

export function registerBotHandlers(
  bot: Bot,
  config: Pick<Config, "isUserAllowed" | "showUserMessages" | "showHiddenDirs" | "telegramBotToken" | "configDir" | "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "resolveWindowForThread"
    | "getWindowForThread"
    | "getDisplayName"
    | "getRecentMessages"
    | "updateUserWindowOffset"
    | "unbindThread"
    | "setGroupChatId"
    | "sendToWindow"
    | "clearWindowSession"
    | "resolveChatId"
    | "iterThreadBindings"
    | "bindThread"
    | "listSessionsForDirectory"
    | "waitForSessionMapEntry"
    | "getWindowState"
    | "saveState"
    | "updateDisplayName"
    | "getSessionByWindow"
    | "getLastEvent"
    | "getRecoveryAnchor"
  >,
  tmuxManager: Pick<
    TmuxManager,
    "findWindowById" | "sendKeys" | "capturePane" | "listWindows" | "createWindow" | "killWindow" | "renameWindow"
  >,
  options: BotHandlerOptions = {}
): void {
  const api = options.api ?? telegramApiFromGrammy(bot);
  const bashCapture =
    options.bashCapture ??
    new BashCaptureManager({
      api,
      routing: sessionManager,
      tmuxManager
    });
  const handlerOptions = { ...options, api, bashCapture };
  bot.command("start", (ctx) => startCommand(ctx, config));
  bot.command("history", (ctx) => historyCommand(ctx, config, sessionManager));
  bot.command("screenshot", (ctx) => screenshotCommand(ctx, config, sessionManager, tmuxManager));
  bot.command("esc", (ctx) => escCommand(ctx, config, sessionManager, tmuxManager));
  bot.command("status", (ctx) => statusCommand(ctx, config, sessionManager, tmuxManager));
  bot.command("kill", (ctx) => killCommand(ctx, config, sessionManager, tmuxManager, handlerOptions));
  bot.command("usage", (ctx) => usageCommand(ctx, config, sessionManager, tmuxManager));
  for (const command of Object.keys(CC_COMMANDS)) {
    bot.command(command, (ctx) => forwardCommandHandler(ctx, config, sessionManager, tmuxManager));
  }
  bot.callbackQuery(/^h[pn]:/, (ctx) => historyCallbackHandler(ctx, config, sessionManager, tmuxManager));
  bot.callbackQuery(/^aq:/, (ctx) => interactiveCallbackHandler(ctx, config, sessionManager, tmuxManager, api));
  bot.callbackQuery(/^(ss:ref:|kb:)/, (ctx) => screenshotCallbackHandler(ctx, config, tmuxManager));
  bot.callbackQuery(/^(db:|wb:|rs:|noop$)/, (ctx) =>
    pickerCallbackHandler(ctx, config, sessionManager, tmuxManager)
  );
  bot.on("message:forum_topic_closed", (ctx) =>
    topicClosedHandler(ctx, config, sessionManager, tmuxManager, handlerOptions)
  );
  bot.on("message:forum_topic_edited", (ctx) => topicEditedHandler(ctx, config, sessionManager, tmuxManager));
  bot.on("message:photo", (ctx) => photoMessageHandler(ctx, config, sessionManager, tmuxManager));
  bot.on("message:text", (ctx) =>
    textMessageHandler(ctx, config, sessionManager, tmuxManager, options.stateStore ?? defaultBotState, handlerOptions)
  );
  bot.on("message", (ctx) => unsupportedContentHandler(ctx, config));

  // Global error boundary. THE load-bearing resilience fix — without an
  // installed `bot.catch`, grammy rethrows any error a handler throws out
  // of the update loop, and in long-polling mode that rejects `bot.start`
  // and kills Telegram polling entirely (the silent-12h-downtime incident).
  // safeAnswerCallback patched the one path we'd observed, but ANY handler
  // throwing — editMessageText on a deleted message, a sendMessage 403, a
  // logic bug — would reproduce the same outage. With bot.catch installed,
  // grammy routes per-update errors here and CONTINUES polling. We log with
  // the update id + the offending update type for forensics, then swallow.
  bot.catch((err) => {
    const update = err.ctx?.update;
    const updateId = update?.update_id;
    // Identify which update kind blew up without dumping the whole payload
    // (which can contain message text / tokens).
    const updateKind = update
      ? Object.keys(update).find((k) => k !== "update_id") ?? "unknown"
      : "unknown";
    sharedLogger().error(
      {
        err: errorMessage(err.error),
        updateId,
        updateKind
      },
      "bot.catch: handler threw; swallowed to keep polling alive"
    );
  });
}

export function createTelegramBot(
  config: Pick<Config, "telegramBotToken" | "isUserAllowed" | "showUserMessages" | "showHiddenDirs" | "configDir" | "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "resolveWindowForThread"
    | "getWindowForThread"
    | "getDisplayName"
    | "getRecentMessages"
    | "updateUserWindowOffset"
    | "unbindThread"
    | "setGroupChatId"
    | "sendToWindow"
    | "clearWindowSession"
    | "resolveChatId"
    | "iterThreadBindings"
    | "bindThread"
    | "listSessionsForDirectory"
    | "waitForSessionMapEntry"
    | "getWindowState"
    | "saveState"
    | "updateDisplayName"
    | "getSessionByWindow"
    | "getLastEvent"
    | "getRecoveryAnchor"
  >,
  tmuxManager: Pick<
    TmuxManager,
    "findWindowById" | "sendKeys" | "capturePane" | "listWindows" | "createWindow" | "killWindow" | "renameWindow"
  >,
  options: BotHandlerOptions = {}
): Bot {
  const bot = createGrammyBot(config.telegramBotToken);
  registerBotHandlers(bot, config, sessionManager, tmuxManager, options);
  return bot;
}

export async function setupBotCommands(
  api: Pick<Bot["api"], "deleteMyCommands" | "setMyCommands">
): Promise<void> {
  await api.deleteMyCommands();
  await api.setMyCommands(BOT_COMMANDS);
}

export async function setupBotCommandsIfPossible(
  api: Pick<Bot["api"], "deleteMyCommands" | "setMyCommands">
): Promise<boolean> {
  try {
    await setupBotCommands(api);
    return true;
  } catch (error) {
    sharedLogger().warn({ err: error }, "failed to set up Telegram command menu; continuing without it");
    return false;
  }
}

async function downloadTelegramPhoto(args: {
  api: TelegramFileApiLike;
  botToken: string;
  fileId: string;
  destination: string;
}): Promise<void> {
  const file = await args.api.getFile(args.fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  const response = await fetch(`https://api.telegram.org/file/bot${args.botToken}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }

  await mkdir(dirname(args.destination), { recursive: true });
  await writeFile(args.destination, Buffer.from(await response.arrayBuffer()));
}

function sanitizePhotoId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return safe || "photo";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseScreenshotKeyCallback(data: string): { keyId: string; windowId: string } | null {
  const rest = data.slice(CB_KEYS_PREFIX.length);
  const colonIndex = rest.indexOf(":");
  if (colonIndex < 0) return null;
  const keyId = rest.slice(0, colonIndex);
  const windowId = rest.slice(colonIndex + 1);
  if (!keyId || !windowId) return null;
  return { keyId, windowId };
}

async function refreshScreenshotMessage(
  ctx: Pick<Context, "editMessageMedia">,
  windowId: string,
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane">
): Promise<boolean> {
  const window = await tmuxManager.findWindowById(windowId);
  if (!window) return false;

  const paneText = await tmuxManager.capturePane(window.windowId, true);
  if (!paneText) return false;

  try {
    const png = await textToImage(paneText, { withAnsi: true });
    await ctx.editMessageMedia(
      {
        type: "document",
        media: new InputFile(png, "screenshot.png")
      },
      {
        reply_markup: buildScreenshotKeyboard(windowId)
      }
    );
    return true;
  } catch {
    return false;
  }
}

function shouldBlockTextForPicker(
  userData: Record<string, unknown>,
  threadId: number | null,
  state: string
): boolean {
  return userData[STATE_KEY] === state && userData[PENDING_THREAD_ID_KEY] === threadId;
}

function clearStalePickerState(
  userData: Record<string, unknown>,
  threadId: number | null,
  state: string
): boolean {
  return userData[STATE_KEY] === state && userData[PENDING_THREAD_ID_KEY] !== threadId;
}

function getPendingThreadId(userData: Record<string, unknown>): number | null {
  const value = userData[PENDING_THREAD_ID_KEY];
  return typeof value === "number" ? value : null;
}

function validatePendingThread(
  ctx: Pick<Context, "answerCallbackQuery">,
  userData: Record<string, unknown>,
  threadId: number | null
): Promise<boolean> {
  const pendingThreadId = getPendingThreadId(userData);
  if (pendingThreadId !== null && pendingThreadId !== threadId) {
    return safeAnswerCallback(ctx, { text: "Stale picker (topic mismatch)", show_alert: true }).then(() => false);
  }
  return Promise.resolve(true);
}

async function handleWindowBindCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery" | "reply">,
  userData: Record<string, unknown>,
  userId: number,
  threadId: number | null,
  data: string,
  sessionManager: Pick<SessionManager, "bindThread" | "sendToWindow">,
  tmuxManager: Pick<TmuxManager, "findWindowById">
): Promise<void> {
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  const index = Number.parseInt(data.slice(CB_WIN_BIND.length), 10);
  const cachedWindows = Array.isArray(userData[UNBOUND_WINDOWS_KEY])
    ? (userData[UNBOUND_WINDOWS_KEY] as string[])
    : [];
  if (!Number.isInteger(index) || index < 0 || index >= cachedWindows.length) {
    await safeAnswerCallback(ctx, { text: "Window list changed, please retry", show_alert: true });
    return;
  }

  const selectedWindowId = cachedWindows[index]!;
  const window = await tmuxManager.findWindowById(selectedWindowId);
  if (!window) {
    await safeAnswerCallback(ctx, { text: "Window no longer exists", show_alert: true });
    return;
  }
  if (threadId === null) {
    await safeAnswerCallback(ctx, { text: "Not in a topic", show_alert: true });
    return;
  }

  clearWindowPickerState(userData);
  sessionManager.bindThread(userId, threadId, selectedWindowId, window.windowName);
  // tmux can produce empty windowName in edge cases — fall back to
  // the windowId so the confirmation message stays informative
  // instead of rendering `Bound to window \`\`` (literal empty
  // backticks, since our markdown converter doesn't form a code
  // entity around empty content).
  const displayName = window.windowName || window.windowId;
  await editTextWithFallback(ctx, `✅ Bound to window \`${displayName}\``);

  await sendPendingText(ctx, userData, selectedWindowId, sessionManager);
  delete userData[PENDING_THREAD_ID_KEY];
  await safeAnswerCallback(ctx, "Bound");
}

async function handleWindowNewCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery">,
  userData: Record<string, unknown>,
  threadId: number | null,
  config: Pick<Config, "showHiddenDirs">
): Promise<void> {
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  clearWindowPickerState(userData);
  const browser = buildDirectoryBrowser(initialBrowsePath(), 0, { showHiddenDirs: config.showHiddenDirs });
  userData[STATE_KEY] = STATE_BROWSING_DIRECTORY;
  userData[BROWSE_PATH_KEY] = resolve(initialBrowsePath());
  userData[BROWSE_PAGE_KEY] = browser.page;
  userData[BROWSE_DIRS_KEY] = browser.subdirs;
  await editTextWithFallback(ctx, browser.text, { reply_markup: browser.keyboard });
  await safeAnswerCallback(ctx);
}

async function handleDirectorySelectCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery">,
  userData: Record<string, unknown>,
  threadId: number | null,
  data: string,
  config: Pick<Config, "showHiddenDirs">
): Promise<void> {
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  const index = Number.parseInt(data.slice(CB_DIR_SELECT.length), 10);
  const cachedDirs = Array.isArray(userData[BROWSE_DIRS_KEY])
    ? (userData[BROWSE_DIRS_KEY] as string[])
    : [];
  if (!Number.isInteger(index) || index < 0 || index >= cachedDirs.length) {
    await safeAnswerCallback(ctx, { text: "Directory list changed, please refresh", show_alert: true });
    return;
  }

  const currentPath = stringValue(userData[BROWSE_PATH_KEY], initialBrowsePath());
  const newPath = resolve(currentPath, cachedDirs[index]!);
  if (!isDirectory(newPath)) {
    await safeAnswerCallback(ctx, { text: "Directory not found", show_alert: true });
    return;
  }

  const browser = buildDirectoryBrowser(newPath, 0, { showHiddenDirs: config.showHiddenDirs });
  userData[BROWSE_PATH_KEY] = newPath;
  userData[BROWSE_PAGE_KEY] = browser.page;
  userData[BROWSE_DIRS_KEY] = browser.subdirs;
  await editTextWithFallback(ctx, browser.text, { reply_markup: browser.keyboard });
  await safeAnswerCallback(ctx);
}

async function handleDirectoryUpCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery">,
  userData: Record<string, unknown>,
  threadId: number | null,
  config: Pick<Config, "showHiddenDirs">
): Promise<void> {
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  const currentPath = stringValue(userData[BROWSE_PATH_KEY], initialBrowsePath());
  const parent = dirname(resolve(currentPath));
  const browser = buildDirectoryBrowser(parent, 0, { showHiddenDirs: config.showHiddenDirs });
  userData[BROWSE_PATH_KEY] = parent;
  userData[BROWSE_PAGE_KEY] = browser.page;
  userData[BROWSE_DIRS_KEY] = browser.subdirs;
  await editTextWithFallback(ctx, browser.text, { reply_markup: browser.keyboard });
  await safeAnswerCallback(ctx);
}

async function handleDirectoryPageCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery">,
  userData: Record<string, unknown>,
  threadId: number | null,
  data: string,
  config: Pick<Config, "showHiddenDirs">
): Promise<void> {
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  const page = Number.parseInt(data.slice(CB_DIR_PAGE.length), 10);
  if (!Number.isInteger(page)) {
    await safeAnswerCallback(ctx, "Invalid data");
    return;
  }
  const currentPath = stringValue(userData[BROWSE_PATH_KEY], initialBrowsePath());
  const browser = buildDirectoryBrowser(currentPath, page, { showHiddenDirs: config.showHiddenDirs });
  userData[BROWSE_PAGE_KEY] = browser.page;
  userData[BROWSE_DIRS_KEY] = browser.subdirs;
  await editTextWithFallback(ctx, browser.text, { reply_markup: browser.keyboard });
  await safeAnswerCallback(ctx);
}

async function handleDirectoryConfirmCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery" | "reply">,
  userData: Record<string, unknown>,
  userId: number,
  threadId: number | null,
  config: Pick<Config, "showHiddenDirs" | "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "listSessionsForDirectory"
    | "bindThread"
    | "waitForSessionMapEntry"
    | "getWindowState"
    | "saveState"
    | "sendToWindow"
    | "getRecoveryAnchor"
  >,
  tmuxManager: Pick<TmuxManager, "createWindow">
): Promise<void> {
  // ACK FIRST — listSessionsForDirectory below can be slow (fs scan), and
  // the fall-through to createAndBindWindow adds the usual tmux + 5-15s
  // wait. See handleSessionSelectCallback for the full rationale.
  await safeAnswerCallback(ctx);
  if (!(await validatePendingThread(ctx, userData, threadId))) {
    clearBrowseState(userData);
    deletePendingText(userData);
    return;
  }

  const selectedPath = stringValue(userData[BROWSE_PATH_KEY], initialBrowsePath());
  clearBrowseState(userData);

  const sessions = await sessionManager.listSessionsForDirectory(selectedPath, config.agentType);
  if (sessions.length > 0) {
    userData[STATE_KEY] = STATE_SELECTING_SESSION;
    userData[SESSIONS_KEY] = sessions;
    userData[SELECTED_PATH_KEY] = selectedPath;
    // If this topic was previously bound to a Claude/Codex session whose tmux
    // window has since vanished (statusPolling soft-cleanup), default-highlight
    // that session in the picker so the user can resume in one tap.
    const anchor = threadId !== null ? sessionManager.getRecoveryAnchor(userId, threadId) : null;
    const picker = buildSessionPicker(sessions, anchor ? { recommendedSessionId: anchor } : {});
    await editTextWithFallback(ctx, picker.text, { reply_markup: picker.keyboard });
    return;
  }

  await createAndBindWindow(ctx, userData, userId, selectedPath, threadId, config.agentType, sessionManager, tmuxManager);
}

async function handleSessionSelectCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery" | "reply">,
  userData: Record<string, unknown>,
  userId: number,
  threadId: number | null,
  data: string,
  config: Pick<Config, "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "bindThread"
    | "listSessionsForDirectory"
    | "waitForSessionMapEntry"
    | "getWindowState"
    | "saveState"
    | "sendToWindow"
  >,
  tmuxManager: Pick<TmuxManager, "createWindow">
): Promise<void> {
  // ACK FIRST. createAndBindWindow below runs `tmux new-window` + a 5-15s
  // waitForSessionMapEntry block + bindThread before returning — a late
  // answerCallbackQuery can easily land past Telegram's ~10 minute
  // callback expiry window, throwing a 400 that historically killed the
  // grammy runtime for ~12 hours of silent downtime. Dismiss the button
  // spinner immediately; the actual outcome is conveyed by the message
  // edit ("✅ Created. Send messages here." / "❌ failure reason").
  await safeAnswerCallback(ctx);
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  const index = Number.parseInt(data.slice(CB_SESSION_SELECT.length), 10);
  const sessions = Array.isArray(userData[SESSIONS_KEY])
    ? (userData[SESSIONS_KEY] as ClaudeSession[])
    : [];
  if (!Number.isInteger(index) || index < 0 || index >= sessions.length) {
    return;
  }

  const session = sessions[index]!;
  const selectedPath = stringValue(userData[SELECTED_PATH_KEY], initialBrowsePath());
  clearSessionPickerState(userData);
  delete userData[SELECTED_PATH_KEY];
  await createAndBindWindow(
    ctx,
    userData,
    userId,
    selectedPath,
    threadId,
    config.agentType,
    sessionManager,
    tmuxManager,
    session.sessionId
  );
}

async function handleSessionNewCallback(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery" | "reply">,
  userData: Record<string, unknown>,
  userId: number,
  threadId: number | null,
  config: Pick<Config, "agentType">,
  sessionManager: Pick<
    SessionManager,
    | "bindThread"
    | "listSessionsForDirectory"
    | "waitForSessionMapEntry"
    | "getWindowState"
    | "saveState"
    | "sendToWindow"
  >,
  tmuxManager: Pick<TmuxManager, "createWindow">
): Promise<void> {
  // ACK FIRST — see handleSessionSelectCallback for the rationale.
  await safeAnswerCallback(ctx);
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  const selectedPath = stringValue(userData[SELECTED_PATH_KEY], initialBrowsePath());
  clearSessionPickerState(userData);
  delete userData[SELECTED_PATH_KEY];
  await createAndBindWindow(ctx, userData, userId, selectedPath, threadId, config.agentType, sessionManager, tmuxManager);
}

type ResumeSessionManager = Pick<SessionManager, "sendToWindow"> &
  Partial<Pick<SessionManager, "bindThread" | "waitForSessionMapEntry" | "deleteWindow">>;

/**
 * Shared core for lazy session recovery: recreate a tmux window at `cwd` running
 * `claude --resume <resumeSessionId>`, rebind the topic to it, and forward
 * `pendingText`. Returns `true` if it handled the message (resumed, or
 * tried-and-failed with a user-facing error), `false` if it can't resume
 * (capability not wired / cwd gone) so the caller falls back.
 */
async function resumeOntoNewWindow(
  ctx: Pick<Context, "reply">,
  userId: number,
  threadId: number,
  cwd: string,
  resumeSessionId: string,
  pendingText: string,
  sessionManager: ResumeSessionManager,
  tmuxManager: Partial<Pick<TmuxManager, "createWindow">>,
  options: BotHandlerOptions,
  // Fast-path only: the dead window id we're resuming away from. The window row
  // is still in the DB (statusPolling hasn't soft-deleted it yet), so clean it
  // up after a successful rebind. Omitted by the recovery branch, whose old
  // window was already deleted by statusPolling.
  staleWindowId?: string
): Promise<boolean> {
  // Capability gate: legacy/partial call sites (and some unit tests) don't wire
  // these. Without them we can't resume — let the caller fall back.
  if (!tmuxManager.createWindow || !sessionManager.bindThread) return false;
  if (!isDirectory(cwd)) {
    // cwd recorded but no longer on disk (dir deleted/unmounted). Nothing to
    // resume into — fall back so the user gets the clean "start over" path.
    return false;
  }

  await replyWithFallback(ctx, "🔄 Restoring previous session after restart…");

  const [success, message, windowName, newWindowId] = await tmuxManager.createWindow(cwd, {
    resumeSessionId
  });
  if (!success || !newWindowId) {
    await replyWithFallback(ctx, `❌ Failed to restore session: ${message}`);
    return true;
  }

  // `--resume` is slower to emit its SessionStart than a fresh launch; give the
  // hook extra time to register the new window before we bind + forward.
  await sessionManager.waitForSessionMapEntry?.(newWindowId, 15);
  sessionManager.bindThread!(userId, threadId, newWindowId, windowName);

  // Drop the orphaned dead-window row we resumed away from. Guard the id-reuse
  // case where a fresh tmux server handed us back the same id — deleting that
  // would cascade away the session we just created.
  if (staleWindowId && staleWindowId !== newWindowId) {
    sessionManager.deleteWindow?.(staleWindowId);
  }

  options.bashCapture?.cancel(userId, threadId);
  const [sent, sendMessage] = await sessionManager.sendToWindow(newWindowId, pendingText);
  if (!sent) {
    await replyWithFallback(ctx, `✅ Session restored, but forwarding your message failed: ${sendMessage}`);
    return true;
  }
  if (pendingText.startsWith("!") && pendingText.length > 1) {
    options.bashCapture?.start(userId, threadId, newWindowId, pendingText.slice(1));
  }

  sharedLogger().info(
    { userId, threadId, newWindowId, resumeSessionId, cwd },
    "lazy-resumed bound topic onto a fresh window after the old one vanished"
  );
  return true;
}

/**
 * Fast-path lazy resume: the binding still points at a window id, but that
 * window is dead in tmux (user messaged in the ~2s after a reboot, before
 * statusPolling soft-deleted the binding). The sessions row hasn't been
 * cascade-deleted yet, so cwd + session_id are still on it.
 */
async function tryResumeBoundWindow(
  ctx: Pick<Context, "reply">,
  userId: number,
  threadId: number,
  oldWindowId: string,
  pendingText: string,
  sessionManager: Pick<SessionManager, "getSessionByWindow" | "sendToWindow"> &
    Partial<Pick<SessionManager, "bindThread" | "waitForSessionMapEntry" | "deleteWindow">>,
  tmuxManager: Partial<Pick<TmuxManager, "createWindow">>,
  options: BotHandlerOptions
): Promise<boolean> {
  const prior = sessionManager.getSessionByWindow(oldWindowId);
  if (!prior?.cwd || !prior.session_id) return false;
  return resumeOntoNewWindow(
    ctx,
    userId,
    threadId,
    prior.cwd,
    prior.session_id,
    pendingText,
    sessionManager,
    tmuxManager,
    options,
    oldWindowId
  );
}

async function createAndBindWindow(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery" | "reply">,
  userData: Record<string, unknown>,
  userId: number,
  selectedPath: string,
  threadId: number | null,
  _agentType: AgentType,
  sessionManager: Pick<
    SessionManager,
    "bindThread" | "waitForSessionMapEntry" | "sendToWindow"
  >,
  tmuxManager: Pick<TmuxManager, "createWindow">,
  resumeSessionId: string | null = null
): Promise<void> {
  const [success, message, createdWindowName, createdWindowId] = await tmuxManager.createWindow(selectedPath, {
    resumeSessionId
  });
  if (!success) {
    await editTextWithFallback(ctx, `❌ ${message}`);
    deletePendingText(userData);
    return;
  }

  // Block briefly so the SessionStart hook can populate Registry before we
  // bind the topic + forward the user's first message. Post-refactor Registry
  // is the only place that matters for transcript reads, so the legacy
  // state.sessionId override on resume is no longer necessary — the hook's
  // transcript_path is authoritative regardless of which session_id Claude
  // reports.
  await sessionManager.waitForSessionMapEntry(createdWindowId, resumeSessionId ? 15 : 5);

  if (threadId !== null) {
    sessionManager.bindThread(userId, threadId, createdWindowId, createdWindowName);
    const status = resumeSessionId ? "Resumed" : "Created";
    await editTextWithFallback(ctx, `✅ ${message}\n\n${status}. Send messages here.`);
    await sendPendingText(ctx, userData, createdWindowId, sessionManager);
    delete userData[PENDING_THREAD_ID_KEY];
  } else {
    await editTextWithFallback(ctx, `✅ ${message}`);
    deletePendingText(userData);
  }
  // Note: callbackQuery already acked at the entry of the callback handler
  // (handleSessionSelectCallback / handleSessionNewCallback /
  // handleDirectoryConfirmCallback) — see the rationale comment there.
  // Outcome is conveyed via the editMessageText above.
}

async function sendPendingText(
  ctx: Pick<Context, "reply">,
  userData: Record<string, unknown>,
  windowId: string,
  sessionManager: Pick<SessionManager, "sendToWindow">
): Promise<void> {
  const pendingText = userData[PENDING_THREAD_TEXT_KEY];
  delete userData[PENDING_THREAD_TEXT_KEY];
  if (typeof pendingText !== "string" || !pendingText) return;

  const [sent, sendMessage] = await sessionManager.sendToWindow(windowId, pendingText);
  if (!sent) {
    await replyWithFallback(ctx, `❌ Failed to send pending message: ${sendMessage}`);
  }
}

async function cancelPicker(
  ctx: Pick<Context, "editMessageText" | "answerCallbackQuery">,
  userData: Record<string, unknown>,
  threadId: number | null,
  clearState: (userData: Record<string, unknown>) => void,
  extra?: () => void
): Promise<void> {
  if (!(await validatePendingThread(ctx, userData, threadId))) return;
  clearState(userData);
  deletePendingText(userData);
  extra?.();
  await editTextWithFallback(ctx, "Cancelled");
  await safeAnswerCallback(ctx, "Cancelled");
}

function deletePendingText(userData: Record<string, unknown>): void {
  delete userData[PENDING_THREAD_ID_KEY];
  delete userData[PENDING_THREAD_TEXT_KEY];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

