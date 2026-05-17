import type { SessionRegistry } from "./sessionRegistry.js";
import type { Dispatcher } from "./drainTranscript.js";
import { drainTranscript } from "./drainTranscript.js";
import type { AgentType, HookEnvelope, HookEventName } from "./hookTypes.js";

export interface HookRouterDeps {
  registry: SessionRegistry;
  dispatcher: Dispatcher;
  agentType: AgentType;
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
    const event = envelope.payload.hook_event_name as HookEventName;
    switch (event) {
      case "SessionStart":
        return this.onSessionStart(envelope);
      case "SessionEnd":
        return this.onSessionEnd(envelope);
      case "UserPromptSubmit":
      case "PostToolUse":
      case "PostToolBatch":
      case "PostToolUseFailure":
      case "Stop":
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
    const sessionId = envelope.payload.session_id;
    await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
  }

  private async onSessionEnd(envelope: HookEnvelope): Promise<void> {
    const sessionId = envelope.payload.session_id;
    await drainTranscript(this.deps.registry, this.deps.dispatcher, sessionId);
    this.deps.registry.endSession(sessionId);
  }
}
