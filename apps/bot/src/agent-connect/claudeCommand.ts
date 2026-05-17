export const DEFAULT_CLAUDE_PERMISSION_MODE = "bypassPermissions";
export const DEFAULT_CLAUDE_COMMAND = `claude --permission-mode ${DEFAULT_CLAUDE_PERMISSION_MODE}`;
export const DEFAULT_CODEX_COMMAND = "codex --yolo";
export const DEFAULT_AGENT_TYPE = "claude";

export type AgentType = "claude" | "codex";

const PERMISSION_MODE_RE = /(?:^|\s)--permission-mode(?:=|\s+|$)/;
const LEGACY_BYPASS_RE = /(?:^|\s)--dangerously-skip-permissions(?:\s|$)/;
const CODEX_YOLO_RE = /(?:^|\s)--yolo(?:\s|$)/;

export function withDefaultClaudePermissionMode(command: string): string {
  const trimmed = command.trim() || "claude";
  if (PERMISSION_MODE_RE.test(trimmed) || LEGACY_BYPASS_RE.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} --permission-mode ${DEFAULT_CLAUDE_PERMISSION_MODE}`;
}

export function buildClaudeCommand(
  command: string,
  options: { resumeSessionId?: string | null | undefined } = {}
): string {
  const baseCommand = withDefaultClaudePermissionMode(command);
  return options.resumeSessionId ? `${baseCommand} --resume ${options.resumeSessionId}` : baseCommand;
}

export function withDefaultCodexYolo(command: string): string {
  const trimmed = command.trim() || "codex";
  if (CODEX_YOLO_RE.test(trimmed)) return trimmed;
  return `${trimmed} --yolo`;
}

export function normalizeAgentType(value: unknown): AgentType {
  return value === "codex" ? "codex" : "claude";
}

export function defaultCommandForAgent(agentType: AgentType): string {
  return agentType === "codex" ? DEFAULT_CODEX_COMMAND : DEFAULT_CLAUDE_COMMAND;
}

export function agentLabel(agentType: AgentType): string {
  return agentType === "codex" ? "Codex" : "Claude Code";
}

export function buildAgentCommand(
  agentType: AgentType,
  command: string,
  options: { resumeSessionId?: string | null | undefined } = {}
): string {
  if (agentType === "codex") {
    const baseCommand = withDefaultCodexYolo(command);
    return options.resumeSessionId ? `${baseCommand} resume ${options.resumeSessionId}` : baseCommand;
  }
  return buildClaudeCommand(command, options);
}
