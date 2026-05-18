import type { SessionRegistry } from "./sessionRegistry.js";
import type { Dispatcher } from "./drainTranscript.js";
import { drainTranscript } from "./drainTranscript.js";
import type { AgentType, HookEnvelope, HookEventName } from "./hookTypes.js";

export type TurnEndOutcome = "success" | "failure";
export type OnTurnEnd = (windowId: string, outcome: TurnEndOutcome) => Promise<void>;

export interface HookRouterDeps {
  registry: SessionRegistry;
  dispatcher: Dispatcher;
  agentType: AgentType;
  onTurnEnd?: OnTurnEnd;
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
      case "PreToolUse":
      case "Notification":
      case "PermissionRequest":
        // Status-only events handled in a later task; currently ignored.
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
    const args = {
      sessionId: payload.session_id,
      windowId: envelope.window_id,
      agentType: this.deps.agentType,
      transcriptPath: payload.transcript_path ?? "",
      cwd: payload.cwd
    } as const;
    if (typeof payload.source === "string") {
      registry.registerSession({ ...args, source: payload.source });
    } else {
      registry.registerSession(args);
    }
  }

  private async onDrain(envelope: HookEnvelope): Promise<void> {
    this.lazyRegisterIfMissing(envelope);
    const sessionId = envelope.payload.session_id;
    await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
  }

  private async onSessionEnd(envelope: HookEnvelope): Promise<void> {
    this.lazyRegisterIfMissing(envelope);
    const sessionId = envelope.payload.session_id;
    await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
    this.deps.registry.endSession(sessionId);
  }

  /**
   * When the bot is started after Claude/Codex are already running, or when
   * a Telegram topic is bound to a pre-existing tmux window, we miss the
   * SessionStart hook for that session. The first event we then see (Stop,
   * PostToolUse, etc.) carries the session_id and transcript_path — use them
   * to register the session lazily. Starts the read offset at 0 so the
   * conversation that prompted this event still gets delivered.
   */
  private lazyRegisterIfMissing(envelope: HookEnvelope): void {
    const { payload } = envelope;
    if (!payload.session_id || !payload.transcript_path) return;
    if (this.deps.registry.getSession(payload.session_id)) return;
    this.deps.registry.upsertWindow(envelope.window_id, envelope.window_name, payload.cwd);
    this.deps.registry.registerSession({
      sessionId: payload.session_id,
      windowId: envelope.window_id,
      agentType: this.deps.agentType,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd,
      source: "lazy"
    });
  }
}
