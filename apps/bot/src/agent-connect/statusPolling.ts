import {
  clearInteractiveMessage,
  getInteractiveWindow,
  handleInteractiveUi,
  type InteractiveUiDeps
} from "./interactiveUi.js";
import { logger } from "./logger.js";
import type { MessageQueueManager } from "./messageQueue.js";
import { isCompletedStatusLine, isInteractiveUi, parseStatusLine } from "./terminalParser.js";
import { isForumThreadId, threadOptions } from "./telegramThread.js";
import type { TmuxManager } from "./tmuxManager.js";
import type { SessionManager } from "./session.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import { errorMessage } from "./utils.js";

export const STATUS_POLL_INTERVAL = 1.0;
export const TOPIC_CHECK_INTERVAL = 60.0;
export const TOPIC_PROBE_WARNING_INTERVAL = 300.0;

export interface StatusPollingDeps extends InteractiveUiDeps {
  sessionManager: Pick<
    SessionManager,
    "iterThreadBindings" | "unbindThread"
  >;
  registry?: Pick<SessionRegistry, "deleteWindow">;
  tmuxManager: Pick<TmuxManager, "findWindowById" | "capturePane" | "killWindow">;
  messageQueue: Pick<
    MessageQueueManager,
    | "enqueueStatusUpdate"
    | "drain"
    | "getQueue"
    | "clearStatusMsgInfo"
    | "clearToolMsgIdsForTopic"
    | "clearLastAssistantMessageId"
  >;
}

export async function updateStatusMessage(
  deps: StatusPollingDeps,
  userId: number,
  windowId: string,
  threadId: number | null = null,
  options: { skipStatus?: boolean } = {}
): Promise<void> {
  const window = await deps.tmuxManager.findWindowById(windowId);
  if (!window) {
    if (!options.skipStatus) {
      deps.messageQueue.enqueueStatusUpdate(userId, windowId, null, threadId);
      await deps.messageQueue.drain(userId);
    }
    return;
  }

  const paneText = await deps.tmuxManager.capturePane(window.windowId);
  if (!paneText) return;

  const interactiveWindow = getInteractiveWindow(userId, threadId);
  let shouldCheckNewUi = true;

  if (interactiveWindow === windowId) {
    if (isInteractiveUi(paneText)) return;
    await clearInteractiveMessage(deps, userId, threadId);
    shouldCheckNewUi = false;
  } else if (interactiveWindow !== null) {
    await clearInteractiveMessage(deps, userId, threadId);
  }

  if (shouldCheckNewUi && isInteractiveUi(paneText)) {
    await handleInteractiveUi(deps, userId, windowId, threadId);
    return;
  }

  if (options.skipStatus) return;

  const statusLine = parseStatusLine(paneText);
  if (statusLine) {
    deps.messageQueue.enqueueStatusUpdate(
      userId,
      windowId,
      isCompletedStatusLine(statusLine) ? null : statusLine,
      threadId
    );
    await deps.messageQueue.drain(userId);
  }
}

export class StatusPoller {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sleepResolve: (() => void) | null = null;
  private lastTopicCheck = 0;
  private readonly topicProbeWarnings = new Map<string, number>();

  constructor(
    private readonly deps: StatusPollingDeps,
    private readonly pollInterval = STATUS_POLL_INTERVAL,
    private readonly topicCheckInterval = TOPIC_CHECK_INTERVAL
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.sleepResolve?.();
    this.sleepResolve = null;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        // Keep polling after transient tmux or Telegram errors, but log so
        // a persistent failure can be diagnosed (e.g. tmux server died).
        logger().warn({ err }, "statusPolling tick failed");
      }
      if (this.running) await this.sleepPollInterval();
    }
  }

  async tick(): Promise<void> {
    await this.probeTopics();

    for (const [userId, threadId, windowId] of [...this.deps.sessionManager.iterThreadBindings()]) {
      const window = await this.deps.tmuxManager.findWindowById(windowId);
      if (!window) {
        await cleanupTopicBinding(this.deps, userId, threadId, windowId, false);
        continue;
      }

      const queue = this.deps.messageQueue.getQueue(userId);
      await updateStatusMessage(this.deps, userId, windowId, threadId, {
        skipStatus: queue !== null && queue.length > 0
      });
    }
  }

  private async probeTopics(): Promise<void> {
    if (this.topicCheckInterval <= 0) return;
    if (!this.deps.api.sendChatAction) return;

    const now = Date.now() / 1000;
    if (now - this.lastTopicCheck < this.topicCheckInterval) return;
    this.lastTopicCheck = now;

    for (const [userId, threadId, windowId] of [...this.deps.sessionManager.iterThreadBindings()]) {
      if (!isForumThreadId(threadId)) continue;
      try {
        const chatId = this.deps.routing.resolveChatId(userId, threadId);
        await this.deps.api.sendChatAction(chatId, "typing", threadOptions(threadId));
      } catch (error) {
        if (isTopicInvalidError(error)) {
          await cleanupTopicBinding(this.deps, userId, threadId, windowId, true);
        } else if (isBenignTopicProbeError(error)) {
          continue;
        } else {
          this.warnTopicProbeFailure(userId, threadId, windowId, error);
        }
      }
    }
  }

  private warnTopicProbeFailure(
    userId: number,
    threadId: number,
    windowId: string,
    error: unknown
  ): void {
    const key = `${userId}:${threadId}:${windowId}`;
    const now = Date.now() / 1000;
    const last = this.topicProbeWarnings.get(key) ?? 0;
    if (now - last < TOPIC_PROBE_WARNING_INTERVAL) return;
    this.topicProbeWarnings.set(key, now);
    logger().warn(
      { userId, threadId, windowId, err: errorMessage(error) },
      "statusPolling topic probe failed"
    );
  }

  private sleepPollInterval(): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sleepResolve = null;
        resolve();
      }, this.pollInterval * 1000);
    });
  }
}

async function cleanupTopicBinding(
  deps: StatusPollingDeps,
  userId: number,
  threadId: number,
  windowId: string,
  killWindow: boolean
): Promise<void> {
  if (killWindow) {
    const window = await deps.tmuxManager.findWindowById(windowId);
    if (window) await deps.tmuxManager.killWindow(window.windowId);
  }

  deps.sessionManager.unbindThread(userId, threadId);
  // Drop the registry row so FK CASCADE clears sessions + user_window_offsets +
  // any leftover thread_bindings row for this window. Without this, bot.sqlite
  // accumulates one dead window per kill forever.
  deps.registry?.deleteWindow(windowId);
  deps.messageQueue.clearStatusMsgInfo(userId, threadId);
  deps.messageQueue.clearToolMsgIdsForTopic(userId, threadId);
  deps.messageQueue.clearLastAssistantMessageId(userId, threadId);
  await clearInteractiveMessage(deps, userId, threadId);
}

function isTopicInvalidError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();
  if (
    message.includes("topic_id_invalid") ||
    message.includes("message thread not found") ||
    message.includes("thread not found") ||
    message.includes("topic not found") ||
    message.includes("forum topic not found")
  ) {
    return true;
  }

  if (typeof error === "object" && error !== null) {
    const description = "description" in error ? (error as { description?: unknown }).description : undefined;
    if (typeof description === "string" && isTopicInvalidError(description)) return true;
  }
  return false;
}

function isBenignTopicProbeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  // topic_closed: user closed but did not delete — they may reopen and expect
  // the session to still be there. Don't kill the tmux window on this signal.
  // (forum_topic_closed event handler handles the deliberate-close case.)
  return (
    message.includes("reaction_empty") ||
    message.includes("reactions are disabled") ||
    message.includes("topic_closed") ||
    message.includes("not enough rights to send chat action")
  );
}
