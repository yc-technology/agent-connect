import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installBundledSkills } from "../src/agent-connect/skillInstaller.js";
import { installCaptureLogger, type TestLoggerHandle } from "./helpers/testLogger.js";

let workRoot: string;
let sourceDir: string;
let claudeRoot: string;
let codexRoot: string;
let log: TestLoggerHandle;

beforeEach(async () => {
  log = installCaptureLogger();
  workRoot = await mkdtemp(join(tmpdir(), "agc-skill-test-"));
  sourceDir = join(workRoot, "skills");
  claudeRoot = join(workRoot, "claude-skills");
  codexRoot = join(workRoot, "codex-skills");
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function targets() {
  return [
    { agent: "claude", root: claudeRoot },
    { agent: "codex", root: codexRoot }
  ];
}

async function writeSkill(name: string, body: string): Promise<void> {
  const dir = join(sourceDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
}

describe("installBundledSkills", () => {
  it("creates skill files under both Claude and Codex roots on first run", async () => {
    await writeSkill("agc-demo", "# demo skill body\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.action === "created")).toBe(true);

    const claudeBody = await readFile(join(claudeRoot, "agc-demo", "SKILL.md"), "utf8");
    const codexBody = await readFile(join(codexRoot, "agc-demo", "SKILL.md"), "utf8");
    expect(claudeBody).toBe("# demo skill body\n");
    expect(codexBody).toBe("# demo skill body\n");

    // Both creations should have logged at info.
    const created = log.records.filter((r) => r.msg === "installed bundled skill");
    expect(created).toHaveLength(2);
  });

  it("returns 'unchanged' and skips the write when the file already matches", async () => {
    await writeSkill("agc-demo", "matching body\n");
    await installBundledSkills({ sourceDir, targets: targets() });
    const installLogsBefore = log.records.filter((r) => r.msg === "installed bundled skill").length;

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    expect(reports.every((r) => r.action === "unchanged")).toBe(true);
    const installLogsAfter = log.records.filter((r) => r.msg === "installed bundled skill").length;
    // Silent on no-op — no NEW info logs.
    expect(installLogsAfter).toBe(installLogsBefore);
  });

  it("returns 'updated' and rewrites when content drifts", async () => {
    await writeSkill("agc-demo", "v1 body\n");
    await installBundledSkills({ sourceDir, targets: targets() });
    // User (or some other process) corrupts one of the copies.
    await writeFile(join(claudeRoot, "agc-demo", "SKILL.md"), "tampered\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    const claudeReport = reports.find((r) => r.agent === "claude")!;
    const codexReport = reports.find((r) => r.agent === "codex")!;
    expect(claudeReport.action).toBe("updated");
    expect(codexReport.action).toBe("unchanged");

    const claudeBody = await readFile(join(claudeRoot, "agc-demo", "SKILL.md"), "utf8");
    expect(claudeBody).toBe("v1 body\n");
  });

  it("processes multiple skills in the source directory", async () => {
    await writeSkill("agc-one", "one\n");
    await writeSkill("agc-two", "two\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    expect(reports).toHaveLength(4); // 2 skills × 2 targets
    expect(reports.map((r) => r.skillName).sort()).toEqual([
      "agc-one",
      "agc-one",
      "agc-two",
      "agc-two"
    ]);
  });

  it("skips directories that have no SKILL.md", async () => {
    await mkdir(join(sourceDir, "no-skill-md"), { recursive: true });
    await writeSkill("real-skill", "ok\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    expect(reports.map((r) => r.skillName)).toEqual(["real-skill", "real-skill"]);
  });

  it("returns an empty list when the source directory does not exist", async () => {
    const reports = await installBundledSkills({
      sourceDir: join(workRoot, "no-such-dir"),
      targets: targets()
    });
    expect(reports).toEqual([]);
  });

  it("force=true rewrites even when the file matches", async () => {
    await writeSkill("agc-demo", "same\n");
    await installBundledSkills({ sourceDir, targets: targets() });

    const reports = await installBundledSkills({
      sourceDir,
      targets: targets(),
      force: true
    });

    expect(reports.every((r) => r.action === "updated")).toBe(true);
  });
});
