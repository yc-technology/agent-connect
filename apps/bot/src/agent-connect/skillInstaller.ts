import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/**
 * On bot service startup, sync the bundled `skills/<name>/` directory tree
 * into the user's Claude and Codex skill directories so both agents
 * discover our skills (`agc-send-file` + any future ones) without manual
 * install. Copies the WHOLE subtree, so skills with `references/`,
 * `assets/`, or scripts ship intact — not just `SKILL.md`.
 *
 * Idempotent: per-file byte compare, only writes the files that differ.
 * Logs one info line per skill that actually had a write (created or
 * updated); silent on no-op so daemon restarts don't spam the log.
 *
 * **Behavior: bundled wins.** If a user hand-edits a file under
 * `~/.claude/skills/<name>/`, the next bot restart will overwrite it
 * with the bundled bytes and log `action: "updated"` (we can't tell
 * "user tweak" from "stale bundled version" without a manifest). Power
 * users who want to customize should copy the skill to a new name.
 *
 * Source resolution prefers the built `dist/skills/` (production install
 * via `npm i -g`), then falls back to the repo's `apps/bot/skills/` for
 * `pnpm dev:bot` where tsc never ran. Returns gracefully when neither
 * exists rather than crashing the bot.
 */

const TARGETS: ReadonlyArray<{ agent: string; root: string }> = [
  { agent: "claude", root: join(homedir(), ".claude", "skills") },
  { agent: "codex", root: join(homedir(), ".codex", "skills") }
];

export interface InstallSkillsOptions {
  // Override source dir, for tests.
  sourceDir?: string;
  // Override target dirs, for tests.
  targets?: Array<{ agent: string; root: string }>;
  // Force-write even when unchanged, for tests.
  force?: boolean;
}

export interface SkillInstallReport {
  skillName: string;
  agent: string;
  action: "created" | "updated" | "unchanged" | "error";
  // Path to the skill's canonical SKILL.md (or the failing file on error).
  path: string;
  // Number of files actually written (0 when unchanged). Useful for tests
  // that need to assert "recursive copy happened" vs "single SKILL.md
  // touched".
  filesWritten?: number;
  error?: string;
}

export async function installBundledSkills(
  options: InstallSkillsOptions = {}
): Promise<SkillInstallReport[]> {
  const sourceDir = options.sourceDir ?? resolveBundledSkillsDir();
  if (!sourceDir) {
    logger().debug({}, "skillInstaller: no bundled skills dir found, skipping");
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (err) {
    logger().warn({ sourceDir, err }, "skillInstaller: failed to list bundled skills");
    return [];
  }

  const targets = options.targets ?? TARGETS;
  const reports: SkillInstallReport[] = [];

  // Iterate alphabetically so log order is deterministic across filesystems.
  entries.sort();

  for (const skillName of entries) {
    const skillSrcDir = join(sourceDir, skillName);
    let srcStat;
    try {
      srcStat = await stat(skillSrcDir);
    } catch {
      continue;
    }
    if (!srcStat.isDirectory()) continue;

    // Presence of SKILL.md is the marker that this dir is a valid skill
    // (vs an unrelated subfolder we should leave alone).
    if (!existsSync(join(skillSrcDir, "SKILL.md"))) {
      logger().debug({ skillName }, "skillInstaller: skill dir has no SKILL.md, skipping");
      continue;
    }

    let relFiles: string[];
    try {
      relFiles = await listFilesRecursive(skillSrcDir);
    } catch (err) {
      logger().warn({ skillName, err }, "skillInstaller: failed to scan source skill dir");
      continue;
    }

    for (const target of targets) {
      const report = await installOneSkill(
        target,
        skillName,
        skillSrcDir,
        relFiles,
        options.force === true
      );
      reports.push(report);
      if (report.action === "created" || report.action === "updated") {
        logger().info(
          { skillName, agent: report.agent, path: report.path, action: report.action, files: report.filesWritten },
          "installed bundled skill"
        );
      } else if (report.action === "error") {
        logger().warn(
          { skillName, agent: report.agent, path: report.path, err: report.error },
          "skillInstaller: write failed"
        );
      }
    }
  }

  return reports;
}

/**
 * Copy `skillSrcDir/**` into `target.root/<skillName>/**`, per-file byte
 * compare. Returns:
 *   - "created" when the destination dir didn't exist before this run
 *   - "updated" when it existed but ≥1 file's bytes changed (or force=true)
 *   - "unchanged" when every file matched
 *   - "error" if any mkdir/write failed
 * Aborts on first error so a partial-write state is reported (rather than
 * silently continuing to copy more files into a half-broken target).
 */
async function installOneSkill(
  target: { agent: string; root: string },
  skillName: string,
  skillSrcDir: string,
  relFiles: string[],
  force: boolean
): Promise<SkillInstallReport> {
  const dstDir = join(target.root, skillName);
  const dirExistedBefore = existsSync(dstDir);
  let filesWritten = 0;

  for (const rel of relFiles) {
    const srcFile = join(skillSrcDir, rel);
    const dstFile = join(dstDir, rel);
    try {
      await mkdir(dirname(dstFile), { recursive: true });
    } catch (err) {
      return errorReport(target, skillName, dstFile, err);
    }

    let srcBytes: Buffer;
    try {
      srcBytes = await readFile(srcFile);
    } catch (err) {
      return errorReport(target, skillName, srcFile, err);
    }

    let existing: Buffer | null = null;
    try {
      existing = await readFile(dstFile);
    } catch {
      // Missing dest is the normal first-install case.
    }

    if (!force && existing && existing.equals(srcBytes)) continue;

    try {
      await writeFile(dstFile, srcBytes);
      filesWritten += 1;
    } catch (err) {
      return errorReport(target, skillName, dstFile, err);
    }
  }

  // Report path points at SKILL.md (the canonical entry-point of the skill)
  // even when the actual write was a sibling — keeps the log compact.
  const skillFilePath = join(dstDir, "SKILL.md");
  if (filesWritten === 0) {
    return { skillName, agent: target.agent, action: "unchanged", path: skillFilePath, filesWritten: 0 };
  }
  return {
    skillName,
    agent: target.agent,
    action: dirExistedBefore ? "updated" : "created",
    path: skillFilePath,
    filesWritten
  };
}

function errorReport(
  target: { agent: string; root: string },
  skillName: string,
  path: string,
  err: unknown
): SkillInstallReport {
  return {
    skillName,
    agent: target.agent,
    action: "error",
    path,
    error: err instanceof Error ? err.message : String(err)
  };
}

/** Walk a directory; return file paths RELATIVE to `root`. */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out.push(relative(root, full));
      }
      // Symlinks intentionally skipped — we don't expect them in bundled
      // skills and following them could escape the source tree.
    }
  }
  await walk(root);
  out.sort(); // deterministic order for log/test stability
  return out;
}

/**
 * Resolve the source skills directory. Production builds copy the repo
 * `skills/` into `dist/skills/` (see scripts/copy-skills.mjs), so the
 * primary lookup is relative to this compiled module's location. Dev
 * mode (`pnpm dev:bot` via tsx) doesn't build, so fall back to the
 * repo-relative path. Returns null if neither exists.
 */
function resolveBundledSkillsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Production: dist/src/agent-connect/skillInstaller.js → dist/skills/
  const prodCandidate = resolve(here, "..", "..", "skills");
  if (existsSync(prodCandidate)) return prodCandidate;
  // Dev: src/agent-connect/skillInstaller.ts → ../../skills/
  const devCandidate = resolve(here, "..", "..", "..", "skills");
  if (existsSync(devCandidate)) return devCandidate;
  return null;
}
