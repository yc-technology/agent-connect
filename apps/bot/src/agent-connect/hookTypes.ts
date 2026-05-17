// apps/bot/src/agent-connect/hookTypes.ts
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolBatch"
  | "PostToolUseFailure"
  | "Stop"
  | "Notification"
  | "PermissionRequest";

export interface HookCommonFields {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: HookEventName;
  permission_mode?: string;
  model?: string;
}

export interface HookEnvelope {
  tmux_session: string;
  window_id: string;
  window_name: string;
  payload: HookCommonFields & Record<string, unknown>;
}

export type AgentType = "claude" | "codex";
