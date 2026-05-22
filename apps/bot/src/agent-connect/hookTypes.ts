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
  | "StopFailure"
  | "Notification"
  | "PermissionRequest";

/**
 * StopFailure payload fields (in addition to HookCommonFields). Claude Code
 * fires this when a turn ends due to an API error — e.g. /compact getting a
 * 500 from the upstream service. Without handling it, the user sees a stuck
 * "Compacting… 1%" status line because the spinner just vanishes from the
 * pane and our parseStatusLine has no way to know the turn died.
 */
export interface StopFailurePayloadFields {
  error_type?:
    | "rate_limit"
    | "authentication_failed"
    | "oauth_org_not_allowed"
    | "billing_error"
    | "invalid_request"
    | "model_not_found"
    | "server_error"
    | "max_output_tokens"
    | "unknown"
    | string;
  error_message?: string;
}

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
