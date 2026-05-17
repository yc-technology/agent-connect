import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionsForDirectory, encodeCwd } from "../src/agent-connect/sessionLookup.js";

describe("sessionLookup", () => {
  test("encodeCwd replaces non-alphanumeric with dashes", () => {
    expect(encodeCwd("/work/example.proj")).toBe("-work-example-proj");
  });

  test("listSessionsForDirectory returns claude sessions for a project directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "agc-lookup-"));
    const projectsPath = join(root, "projects");
    const cwd = "/work/example";
    const dirName = encodeCwd(cwd);
    mkdirSync(join(projectsPath, dirName), { recursive: true });
    writeFileSync(
      join(projectsPath, dirName, "abc.jsonl"),
      JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n"
    );
    const sessions = await listSessionsForDirectory(
      { claudeProjectsPath: projectsPath, codexHomePath: "", agentType: "claude" },
      cwd
    );
    expect(sessions.map((s) => s.sessionId)).toContain("abc");
  });
});
