import { describe, expect, it } from "vitest";
import { buildAgentCommand, defaultCommandForAgent, withDefaultCodexYolo } from "../src/agent-connect/claudeCommand.js";

describe("agent command helpers", () => {
  it("uses yolo for Codex defaults", () => {
    expect(defaultCommandForAgent("codex")).toBe("codex --yolo");
    expect(withDefaultCodexYolo("codex")).toBe("codex --yolo");
    expect(withDefaultCodexYolo("codex --yolo")).toBe("codex --yolo");
  });

  it("starts and resumes Codex with yolo before the subcommand", () => {
    expect(buildAgentCommand("codex", "codex")).toBe("codex --yolo");
    expect(buildAgentCommand("codex", "codex", { resumeSessionId: "session-id" })).toBe("codex --yolo resume session-id");
  });
});
