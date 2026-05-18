import { stat } from "node:fs/promises";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { Dispatcher } from "./drainTranscript.js";
import { drainTranscript } from "./drainTranscript.js";
import type { AgentType, HookEnvelope, HookEventName } from "./hookTypes.js";
import { TranscriptParser } from "./transcriptParser.js";

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

export class HookRouter {
  private readonly windowQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: HookRouterDeps) {}

  dispatch(envelope: HookEnvelope): Promise<void> {
    const key = envelope.window_id;
    const prev = this.windowQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.handleOne(envelope)).catch((err) => {
      console.warn("[hookRouter]", err);
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
      console.warn("[hookRouter onTurnEnd]", err);
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
      console.warn("[hookRouter onStatusEvent]", err);
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

    // `source=resume` reuses an existing transcript file that already contains
    // the entire prior conversation. If we leave last_byte_offset=0, the next
    // drain re-emits every historical entry to Telegram. Stat the file and
    // skip to current EOF so only post-resume entries get delivered.
    // (`startup`/`clear`/`compact` either create a fresh file or rewrite it
    // smaller — drainTranscript already handles size-shrink — so they keep
    // the default offset=0.)
    let lastByteOffset = 0;
    if (payload.source === "resume" && payload.transcript_path) {
      try {
        const s = await stat(payload.transcript_path);
        lastByteOffset = s.size;
      } catch {
        // File doesn't exist yet — fall through with offset 0.
      }
    }

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
   * When the bot is started after Claude/Codex are already running, or when
   * a Telegram topic is bound to a pre-existing tmux window, we miss the
   * SessionStart hook for that session. The first event we then see (Stop,
   * PostToolUse, etc.) carries the session_id and transcript_path — use them
   * to register the session lazily.
   *
   * Seed `last_byte_offset` to the current file size (NOT 0) so the historical
   * conversation already in the transcript does NOT get re-emitted to Telegram.
   * Trade-off: the specific turn whose hook triggered this registration is also
   * skipped, but that is strictly better than dumping hours of history; the
   * user can send a new prompt to bootstrap. Bot restarts that find existing
   * SQLite rows go through the startup catch-up path instead and resume from
   * the persisted offset — they are unaffected by this branch.
   */
  private async lazyRegisterIfMissing(envelope: HookEnvelope): Promise<void> {
    const { payload } = envelope;
    if (!payload.session_id || !payload.transcript_path) return;
    if (this.deps.registry.getSession(payload.session_id)) return;
    this.deps.registry.upsertWindow(envelope.window_id, envelope.window_name, payload.cwd);

    let lastByteOffset = 0;
    try {
      const s = await stat(payload.transcript_path);
      lastByteOffset = s.size;
    } catch {
      // File doesn't exist yet — fall through with offset 0.
    }

    this.deps.registry.registerSession({
      sessionId: payload.session_id,
      windowId: envelope.window_id,
      agentType: this.deps.agentType,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd,
      source: "lazy",
      lastByteOffset
    });
  }
}
