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

  it("recursively copies references/ and assets/ subtrees, not just SKILL.md", async () => {
    // A real skill with companion files. Without recursion, the references/
    // and assets/ files would be silently dropped — the SKILL.md would land
    // but its links would dangle in the user's skills dir.
    const skillDir = join(sourceDir, "rich-skill");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# rich\n");
    await writeFile(join(skillDir, "references", "guide.md"), "ref body\n");
    await writeFile(join(skillDir, "assets", "template.html"), "<html></html>\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    expect(reports).toHaveLength(2);
    for (const r of reports) {
      expect(r.action).toBe("created");
      expect(r.filesWritten).toBe(3); // SKILL.md + references/guide.md + assets/template.html
    }
    // Verify the actual files landed where they should under each agent root.
    for (const root of [claudeRoot, codexRoot]) {
      expect(await readFile(join(root, "rich-skill", "SKILL.md"), "utf8")).toBe("# rich\n");
      expect(await readFile(join(root, "rich-skill", "references", "guide.md"), "utf8")).toBe(
        "ref body\n"
      );
      expect(
        await readFile(join(root, "rich-skill", "assets", "template.html"), "utf8")
      ).toBe("<html></html>\n");
    }
  });

  it("only writes the files that drifted (per-file byte compare)", async () => {
    const skillDir = join(sourceDir, "partial-drift");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "v1\n");
    await writeFile(join(skillDir, "references", "a.md"), "a-v1\n");
    await writeFile(join(skillDir, "references", "b.md"), "b-v1\n");
    await installBundledSkills({ sourceDir, targets: targets() });

    // Drift only the SKILL.md in claudeRoot; the references should be left
    // alone in subsequent runs.
    await writeFile(join(claudeRoot, "partial-drift", "SKILL.md"), "tampered\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    const claudeR = reports.find((r) => r.agent === "claude" && r.skillName === "partial-drift")!;
    const codexR = reports.find((r) => r.agent === "codex" && r.skillName === "partial-drift")!;
    expect(claudeR.action).toBe("updated");
    expect(claudeR.filesWritten).toBe(1); // only SKILL.md got rewritten
    expect(codexR.action).toBe("unchanged");
    expect(codexR.filesWritten).toBe(0);
  });

  it("uses sorted skill order so log output is deterministic", async () => {
    await writeSkill("zebra", "z\n");
    await writeSkill("alpha", "a\n");
    await writeSkill("middle", "m\n");

    const reports = await installBundledSkills({ sourceDir, targets: targets() });

    // 3 skills × 2 targets = 6 reports, two consecutive per skill (claude
    // then codex per inner loop). Skills should arrive alphabetically.
    const skillsInOrder = reports.map((r) => r.skillName);
    expect(skillsInOrder).toEqual([
      "alpha",
      "alpha",
      "middle",
      "middle",
      "zebra",
      "zebra"
    ]);
  });
});

describe("installBundledSkills resolution path (integration)", () => {
  // Catches refactor breakage in resolveBundledSkillsDir: if the file moves
  // and the relative ../ math doesn't follow, the function silently returns
  // null and skills never install. We call WITHOUT sourceDir override so
  // the real path resolver runs; the repo's `apps/bot/skills/` should be
  // discoverable from the source file's vitest location.
  it("locates the real bundled skills dir without an override", async () => {
    log = installCaptureLogger();
    const tmp = await mkdtemp(join(tmpdir(), "agc-skill-resolve-"));
    try {
      const reports = await installBundledSkills({
        targets: [
          { agent: "claude", root: join(tmp, "claude") },
          { agent: "codex", root: join(tmp, "codex") }
        ]
      });
      // The in-tree `agc-send-file` skill MUST show up, otherwise the path
      // resolver missed it and the production bot would silently install
      // nothing.
      expect(reports.length).toBeGreaterThan(0);
      const sendFile = reports.find((r) => r.skillName === "agc-send-file");
      expect(sendFile, "agc-send-file skill should be discoverable via real path resolution").toBeTruthy();
      expect(sendFile!.action).toBe("created");
      expect(sendFile!.filesWritten).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
