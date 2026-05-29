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
import type { TmuxManager, TmuxWindow } from "./tmuxManager.js";
import type { SessionManager } from "./session.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import { errorMessage } from "./utils.js";

// Default cadence. tick() also issues one tmux exec per binding for capturePane,
// so on a busy laptop with many bindings this multiplies fast. Override via
// AGENT_CONNECT_STATUS_POLL_INTERVAL_MS for snappier (lower) or laggier (higher).
// We bumped the default from 1.0 → 2.0 after a fork-rate incident: at 1 Hz, the
// kernel emitted DYLD-unnest warnings for every tmux client we spawned, and
// after ~13h the tmux server died and statusPolling promptly wiped the bot DB.
export const STATUS_POLL_INTERVAL = pollIntervalFromEnv();
export const TOPIC_CHECK_INTERVAL = 60.0;
export const TOPIC_PROBE_WARNING_INTERVAL = 300.0;

function pollIntervalFromEnv(): number {
  const raw = process.env.AGENT_CONNECT_STATUS_POLL_INTERVAL_MS;
  if (!raw) return 2.0;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms < 200) return 2.0;
  return ms / 1000;
}

export interface StatusPollingDeps extends InteractiveUiDeps {
  sessionManager: Pick<
    SessionManager,
    "iterThreadBindings" | "unbindThread" | "markBindingForRecovery"
  >;
  registry?: Pick<SessionRegistry, "deleteWindow" | "listRecoverableBindings">;
  tmuxManager: Pick<
    TmuxManager,
    "findWindowById" | "listWindowsAuthoritative" | "capturePane" | "killWindow"
  >;
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
  window: TmuxWindow,
  threadId: number | null = null,
  options: { skipStatus?: boolean } = {}
): Promise<void> {
  // Caller (tick) has already proven this window is live via a single
  // authoritative listWindowsAuthoritative() call. Re-resolving here would
  // double the tmux exec rate per binding for no benefit.
  const windowId = window.windowId;

  const paneText = await deps.tmuxManager.capturePane(windowId);
  if (!paneText) return;

  const interactiveWindow = getInteractiveWindow(userId, threadId);
  let shouldCheckNewUi = true;

  if (interactiveWindow === windowId) {
    if (isInteractiveUi(paneText)) {
      // Still showing a picker for this window — re-run handleInteractiveUi
      // rather than early-returning. Claude can advance from one
      // AskUserQuestion straight to the next with NO idle gap between them
      // (problem 1 → 2 → 3 in a brainstorm), so isInteractiveUi stays true
      // while the CONTENT changes. The old early-return left Telegram stuck
      // on the first question's text forever; the user saw a stale picker
      // (or a frozen "Thinking…") and answering it did nothing useful.
      // handleInteractiveUi edits the existing message in place and
      // content-dedups, so an unchanged picker costs no API call.
      await handleInteractiveUi(deps, userId, windowId, threadId);
      return;
    }
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
  // parseStatusLine returns null in two cases that both mean "Claude is no
  // longer actively working in this pane":
  //   1. Pane has no chrome (claude TUI not running yet, or window died)
  //   2. Chrome present but no spinner / no progress bar above it —
  //      Claude is idle waiting for input.
  // Either way, any spinner status we previously showed in Telegram is
  // stale. The notable user-facing failure mode this fixes is `/compact`:
  // while compacting we forward "Compacting conversation… 47%", and when
  // it finishes Claude shows the result + idles. Without the null branch,
  // the last %-text sticks in Telegram forever. The messageQueue dedupes
  // status updates by content, so re-enqueueing null when nothing is
  // displayed is effectively a no-op (no extra editMessageText calls).
  deps.messageQueue.enqueueStatusUpdate(
    userId,
    windowId,
    statusLine === null || isCompletedStatusLine(statusLine) ? null : statusLine,
    threadId
  );
  await deps.messageQueue.drain(userId);
}

export class StatusPoller {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sleepResolve: (() => void) | null = null;
  private lastTopicCheck = 0;
  private tmuxUnreachableWarnedAt = 0;
  // Outage state machine. We only NOTIFY the user on a confirmed
  // "down → up" edge (codex review: must distinguish from `{ok:true, windows:[]}`
  // which is a normal post-restart steady state, not an outage).
  // Stage 2b will hang auto-respawn off the same transition; for stage 2a we
  // just post a Telegram heads-up so the user can /join to restore.
  private tmuxState: "unknown" | "up" | "down" = "unknown";
  // Per (chatId:threadId) flag — once a user is notified for the current
  // outage cycle, don't re-notify until the next down→up transition.
  private readonly outageNotified = new Set<string>();
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

    // ONE authoritative tmux call per tick. If tmux is unreachable we skip the
    // entire iteration; we MUST NOT call cleanupTopicBinding in that case —
    // doing so would mistake a transient tmux outage for "every window is gone"
    // and wipe thread_bindings / sessions via FK CASCADE.
    const inventory = await this.deps.tmuxManager.listWindowsAuthoritative();
    if (!inventory.ok) {
      this.warnTmuxUnreachable(inventory.reason, inventory.detail);
      this.tmuxState = "down";
      return;
    }
    const previouslyDown = this.tmuxState === "down";
    this.tmuxState = "up";

    const windowsById = new Map<string, TmuxWindow>();
    for (const w of inventory.windows) windowsById.set(w.windowId, w);

    for (const [userId, threadId, windowId] of [...this.deps.sessionManager.iterThreadBindings()]) {
      const window = windowsById.get(windowId);
      if (!window) {
        // Authoritative: tmux is reachable AND this specific window is not in
        // the list. Soft-delete — preserve last_session_id as a /join anchor
        // (the user can re-attach to the same Claude/Codex session). Hard
        // delete is reserved for "Telegram topic was deleted" via probeTopics.
        await softCleanupTopicBinding(this.deps, userId, threadId, windowId);
        // Binding is gone — drop its probe-warning throttle entry so the
        // map doesn't accumulate dead keys over a long-lived daemon.
        this.topicProbeWarnings.delete(`${userId}:${threadId}:${windowId}`);
        continue;
      }

      const queue = this.deps.messageQueue.getQueue(userId);
      await updateStatusMessage(this.deps, userId, window, threadId, {
        skipStatus: queue !== null && queue.length > 0
      });
    }

    // Notify AFTER cleanup so listRecoverableBindings sees the rows we just
    // flipped to recovery_pending=1 (codex review: notifying before cleanup
    // races with the flag write and risks missing freshly-soft-deleted rows).
    if (previouslyDown) {
      void this.notifyRecoveryAvailable().catch((err) => {
        logger().warn({ err: String(err) }, "statusPolling: notifyRecoveryAvailable failed");
      });
    }
  }

  private warnTmuxUnreachable(reason: string, detail: string): void {
    const now = Date.now() / 1000;
    const last = this.tmuxUnreachableWarnedAt;
    if (now - last < TOPIC_PROBE_WARNING_INTERVAL) return;
    this.tmuxUnreachableWarnedAt = now;
    logger().warn(
      { reason, detail },
      "statusPolling: tmux server unreachable — skipping tick (bindings preserved)"
    );
  }

  // Stage 2a: when tmux comes back up after an outage, post one Telegram
  // message per recoverable thread so the user knows their session anchor
  // (last_session_id) is preserved and a single /join in the topic can
  // restore it. Stage 2b will replace this with an automatic spawn.
  private async notifyRecoveryAvailable(): Promise<void> {
    const registry = this.deps.registry;
    if (!registry) return;
    const sendMessage = this.deps.api.sendMessage;
    if (!sendMessage) return;

    const bindings = registry.listRecoverableBindings();
    if (bindings.length === 0) {
      // No anchors — quiet. Reset the per-cycle dedupe regardless so a future
      // recovery cycle isn't blocked by ghost keys.
      this.outageNotified.clear();
      return;
    }

    // Reset dedupe at the edge so each new outage→recovery cycle re-notifies.
    this.outageNotified.clear();

    for (const b of bindings) {
      const key = `${b.userId}:${b.threadId}`;
      if (this.outageNotified.has(key)) continue;
      this.outageNotified.add(key);
      try {
        const chatId = this.deps.routing.resolveChatId(b.userId, b.threadId);
        const shortId = b.lastSessionId.slice(0, 8);
        await sendMessage(
          chatId,
          `⚠️ tmux server was restarted. The previous session for this topic ` +
            `(session ${shortId}…) is preserved — send any message in this ` +
            `topic to /join and resume it.`,
          threadOptions(b.threadId)
        );
      } catch (err) {
        logger().warn(
          { userId: b.userId, threadId: b.threadId, err: errorMessage(err) },
          "statusPolling: recovery notify failed"
        );
      }
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
          this.topicProbeWarnings.delete(`${userId}:${threadId}:${windowId}`);
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

// Hard delete: user removed the Telegram topic. Tear down everything,
// including the windows row (FK SET NULL leaves no orphans because we
// also wipe thread_bindings via unbindThread first).
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
  deps.registry?.deleteWindow(windowId);
  deps.messageQueue.clearStatusMsgInfo(userId, threadId);
  deps.messageQueue.clearToolMsgIdsForTopic(userId, threadId);
  deps.messageQueue.clearLastAssistantMessageId(userId, threadId);
  await clearInteractiveMessage(deps, userId, threadId);
}

// Soft cleanup: tmux is reachable but THIS specific window is gone (e.g.
// tmux server restart, manual `tmux kill-window`). The topic still exists
// in Telegram, so we want the user to be able to /join and resume the same
// Claude/Codex session. Strategy:
//  - mark the binding for recovery (DB row stays, in-memory routing drops it)
//  - delete the windows row so sessions / user_window_offsets cascade out
//    (FK ON DELETE SET NULL on thread_bindings.window_id keeps the binding
//    intact while nulling out the now-dead window_id)
//  - clear queue + interactive UI state since the prior window is dead
async function softCleanupTopicBinding(
  deps: StatusPollingDeps,
  userId: number,
  threadId: number,
  windowId: string
): Promise<void> {
  deps.sessionManager.markBindingForRecovery(userId, threadId);
  // deleteWindow now triggers FK ON DELETE SET NULL on thread_bindings, so the
  // binding row survives with window_id = NULL + recovery_pending = 1 (set
  // explicitly by markBindingForRecovery above, in case the FK had not yet
  // fired when we read).
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
