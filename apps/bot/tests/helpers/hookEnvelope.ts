// apps/bot/tests/helpers/hookEnvelope.ts
import type { HookEnvelope, HookEventName } from "../../src/agent-connect/hookTypes.js";

export function envelope(
  eventName: HookEventName,
  payload: Record<string, unknown> = {},
  overrides: Partial<HookEnvelope> = {}
): HookEnvelope {
  return {
    tmux_session: overrides.tmux_session ?? "test-session",
    window_id: overrides.window_id ?? "@0",
    window_name: overrides.window_name ?? "test",
    payload: {
      session_id: "X",
      transcript_path: "/tmp/test.jsonl",
      cwd: "/tmp",
      hook_event_name: eventName,
      ...payload,
    },
  };
}
