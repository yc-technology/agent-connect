import { stat } from "node:fs/promises";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { Dispatcher } from "./drainTranscript.js";
import { drainTranscript } from "./drainTranscript.js";
import type { AgentType, HookEnvelope, HookEventName } from "./hookTypes.js";
import { logger } from "./logger.js";
import { TranscriptParser } from "./transcriptParser.js";

function envelopeCtx(envelope: HookEnvelope): Record<string, unknown> {
  return {
    windowId: envelope.window_id,
    sessionId: envelope.payload.session_id,
    event: envelope.payload.hook_event_name
  };
}

export type TurnEndOutcome = "success" | "failure";
export type OnTurnEnd = (windowId: string, outcome: TurnEndOutcome) => Promise<void>;
export type OnStatusEvent = (windowId: string, statusText: string) => Promise<void>;

export interface HookRouterDeps {
  registry: SessionRegistry;
  dispatcher: Dispatcher;
  agentType: AgentType;
  onTurnEnd?: OnTurnEnd;
  onStatusEvent?: OnStatusEvent;
}

/**
 * Seed `last_byte_offset` for a new session row whose transcript file may
 * already contain history we do NOT want to re-emit to Telegram.
 *
 * Universal invariant: a fresh registration marks "anything we deliver from
 * now on must be NEW". Used by every SessionStart (regardless of source) and
 * by lazyRegisterIfMissing. Per-source effect on a real Claude/Codex setup:
 *   - startup / clear: file is brand-new or empty → stat = 0 → no-op.
 *     (Caveat: assumes `/clear` creates a fresh jsonl. Not empirically
 *     verified; if Claude appends in place, the first post-clear turn is
 *     silently skipped — same trade-off as resume. Send another prompt to
 *     bootstrap.)
 *   - resume: file has the full prior conversation → skip to EOF.
 *   - compact: file is NOT truncated (Claude appends a summary) → skip
 *     to EOF; the dispatchCompactDone notification is the user-visible
 *     "finished" signal.
 *   - lazyRegister (bot started after Claude was running, or topic bound
 *     to pre-existing window): same skip-to-EOF semantics.
 *
 * Stat failure (file doesn't exist) silently returns 0, which is the
 * correct "fresh session" behavior. Transient stat failures (permissions
 * flip, NFS hiccup) ALSO return 0 — accepted trade-off: better to risk
 * delivering one historical replay than to block session registration.
 *
 * Trade-off in general: the specific turn whose hook triggered the
 * registration is also skipped, because at hook-fire time the file already
 * contains its contribution. The user can send a fresh prompt to bootstrap —
 * strictly better than re-emitting an arbitrarily long history.
 */
async function offsetSkippingHistory(transcriptPath: string | null | undefined): Promise<number> {
  if (!transcriptPath) return 0;
  try {
    const s = await stat(transcriptPath);
    return s.size;
  } catch {
    return 0;
  }
}

export class HookRouter {
  private readonly windowQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: HookRouterDeps) {}

  dispatch(envelope: HookEnvelope): Promise<void> {
    const key = envelope.window_id;
    const prev = this.windowQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.handleOne(envelope)).catch((err) => {
      logger().warn({ ...envelopeCtx(envelope), err }, "hookRouter dispatch failed");
    });
    this.windowQueues.set(key, next);
    next.finally(() => {
      if (this.windowQueues.get(key) === next) this.windowQueues.delete(key);
    });
    return next as Promise<void>;
  }

  private async handleOne(envelope: HookEnvelope): Promise<void> {
    if (this.shouldIgnore(envelope)) return;
    const event = envelope.payload.hook_event_name as HookEventName;
    // Record activity timestamp regardless of which branch handles the event —
    // /status command reads this to answer "what was Claude up to last?".
    this.deps.registry.recordEvent(envelope.window_id, event);
    switch (event) {
      case "SessionStart":
        return this.onSessionStart(envelope);
      case "SessionEnd":
        return this.onSessionEnd(envelope);
      case "UserPromptSubmit":
      case "PostToolUse":
      case "PostToolBatch":
        return this.onDrain(envelope);
      case "Stop":
        await this.onDrain(envelope);
        await this.fireTurnEnd(envelope, "success");
        return;
      case "StopFailure":
        // Turn ended due to an API error (rate_limit / server_error /
        // billing / …). Without this branch the user would see a stale
        // status line — e.g. "Compacting conversation… 1%" — forever,
        // because the failing spinner just vanishes from the pane and
        // parseStatusLine returns null. Drain first (any partial output
        // that landed before the error should still be delivered), surface
        // the failure to Telegram, then mark the turn as ended.
        await this.onDrain(envelope);
        await this.fireStopFailure(envelope);
        await this.fireTurnEnd(envelope, "failure");
        return;
      case "PostToolUseFailure":
        return this.onDrain(envelope);
      case "PermissionRequest":
        await this.firePermissionRequest(envelope);
        return;
      case "PreToolUse":
      case "Notification":
        // Other status-only events: currently ignored. TUI status line
        // already shows tool progress via StatusPoller.
        return;
      default:
        return;
    }
  }

  private async fireTurnEnd(envelope: HookEnvelope, outcome: TurnEndOutcome): Promise<void> {
    if (!this.deps.onTurnEnd) return;
    try {
      await this.deps.onTurnEnd(envelope.window_id, outcome);
    } catch (err) {
      logger().warn({ ...envelopeCtx(envelope), outcome, err }, "hookRouter onTurnEnd callback failed");
    }
  }

  /**
   * Codex pauses for user approval mid-turn and fires PermissionRequest. The
   * tmux pane shows the prompt but a Telegram-only user has no signal —
   * surface a status update telling them to attach and decide.
   */
  private async firePermissionRequest(envelope: HookEnvelope): Promise<void> {
    if (!this.deps.onStatusEvent) return;
    const { payload } = envelope;
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
    const summary = TranscriptParser.formatToolUseSummary(toolName, payload.tool_input ?? {});
    try {
      await this.deps.onStatusEvent(envelope.window_id, `⚠️ Approval needed: ${summary}`);
    } catch (err) {
      logger().warn({ ...envelopeCtx(envelope), err }, "hookRouter onStatusEvent callback failed");
    }
  }

  /**
   * StopFailure → user-facing Telegram message. We reuse onStatusEvent (same
   * channel as PermissionRequest) so the existing status-message editor
   * naturally OVERWRITES whatever stale spinner text was last shown — this is
   * the whole reason the hook was added: a /compact 500 left "Compacting… 1%"
   * stuck in Telegram because the pane spinner just disappeared with no
   * completion signal.
   */
  private async fireStopFailure(envelope: HookEnvelope): Promise<void> {
    if (!this.deps.onStatusEvent) return;
    const errorType =
      typeof envelope.payload.error_type === "string" ? envelope.payload.error_type : "unknown";
    const errorMessage =
      typeof envelope.payload.error_message === "string" ? envelope.payload.error_message.trim() : "";
    const detail = errorMessage ? ` — ${errorMessage}` : "";
    try {
      await this.deps.onStatusEvent(envelope.window_id, `❌ Turn failed (${errorType})${detail}`);
    } catch (err) {
      logger().warn(
        { ...envelopeCtx(envelope), err },
        "hookRouter onStatusEvent callback failed (StopFailure)"
      );
    }
  }

  /**
   * Multiple agents can live inside one tmux pane — Claude Code 2.x for
   * example spawns a `codex-companion` subprocess that shares the parent's
   * TMUX_PANE. Both sets of hooks route to the same bot by `tmux_session`,
   * and a foreign-agent SessionStart would otherwise DELETE+INSERT over the
   * real session row. Reject events whose transcript_path disagrees with this
   * bot's configured agent type.
   */
  private shouldIgnore(envelope: HookEnvelope): boolean {
    const tp = envelope.payload.transcript_path;
    if (typeof tp !== "string" || !tp) return false;
    const detected: AgentType | null = tp.includes("/.codex/")
      ? "codex"
      : tp.includes("/.claude/")
        ? "claude"
        : null;
    return detected !== null && detected !== this.deps.agentType;
  }

  private async onSessionStart(envelope: HookEnvelope): Promise<void> {
    const { registry } = this.deps;
    const { payload } = envelope;
    registry.upsertWindow(envelope.window_id, envelope.window_name, payload.cwd);

    // See offsetSkippingHistory above for the per-source rationale.
    const lastByteOffset = await offsetSkippingHistory(payload.transcript_path);

    const args = {
      sessionId: payload.session_id,
      windowId: envelope.window_id,
      agentType: this.deps.agentType,
      transcriptPath: payload.transcript_path ?? "",
      cwd: payload.cwd,
      lastByteOffset
    } as const;
    if (typeof payload.source === "string") {
      registry.registerSession({ ...args, source: payload.source });
    } else {
      registry.registerSession(args);
    }

    // `/compact` runs a long progress bar in the TUI and ends silently —
    // there is no transcript text the user would recognize as "compact done"
    // until the next prompt fires a drain. Push an explicit notification so
    // Telegram users know the session is ready to continue.
    //
    // Awaited (not fire-and-forget) so subsequent hooks for the same window
    // queue behind it and the user always sees "Compact done" before the
    // next assistant text. Cost: a slow Telegram send blocks this window's
    // queue for the duration. Acceptable — the alternative loses ordering.
    if (payload.source === "compact") {
      await this.dispatchCompactDone(envelope);
    }
  }

  private async dispatchCompactDone(envelope: HookEnvelope): Promise<void> {
    try {
      await this.deps.dispatcher(envelope.window_id, [
        {
          sessionId: envelope.payload.session_id,
          windowId: envelope.window_id,
          text: "✨ Compact done — conversation summarized, ready to continue.",
          isComplete: true,
          contentType: "text",
          role: "assistant"
        }
      ]);
    } catch (err) {
      logger().warn({ ...envelopeCtx(envelope), err }, "hookRouter compact-done dispatch failed");
    }
  }

  private async onDrain(envelope: HookEnvelope): Promise<void> {
    await this.lazyRegisterIfMissing(envelope);
    const sessionId = envelope.payload.session_id;
    await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
  }

  private async onSessionEnd(envelope: HookEnvelope): Promise<void> {
    await this.lazyRegisterIfMissing(envelope);
    const sessionId = envelope.payload.session_id;
    await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
    this.deps.registry.endSession(sessionId);
  }

  /**
   * Bot started after Claude/Codex was already running, or a Telegram topic
   * was bound to a pre-existing tmux window — so we missed SessionStart.
   * Register the session from whatever hook arrived first; `offsetSkippingHistory`
   * keeps the historical transcript out of Telegram. Bot restarts that find
   * an existing SQLite row go through the startup catch-up path with the
   * persisted offset and never reach this branch.
   */
  private async lazyRegisterIfMissing(envelope: HookEnvelope): Promise<void> {
    const { payload } = envelope;
    if (!payload.session_id || !payload.transcript_path) return;
    if (this.deps.registry.getSession(payload.session_id)) return;
    this.deps.registry.upsertWindow(envelope.window_id, envelope.window_name, payload.cwd);
    const lastByteOffset = await offsetSkippingHistory(payload.transcript_path);
    this.deps.registry.registerSession({
      sessionId: payload.session_id,
      windowId: envelope.window_id,
      agentType: this.deps.agentType,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd,
      source: "lazy",
      lastByteOffset
    });
    logger().info(
      { ...envelopeCtx(envelope), transcriptPath: payload.transcript_path, lastByteOffset },
      "lazy-registered session from non-SessionStart hook (bot started after agent, or topic bound to pre-existing window)"
    );
  }
}
