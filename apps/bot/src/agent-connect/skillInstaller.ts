import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/**
 * On bot service startup, sync the bundled `skills/<name>/SKILL.md` files
 * into the user's Claude and Codex skill directories so both agents
 * discover the `agc-send-file` skill (and any other skills we ship later)
 * without manual install steps.
 *
 * Idempotent: compares bytes and only writes on change. Logs a single
 * info line per skill that actually got created/updated; stays silent
 * when up-to-date so daemon restarts don't spam the log.
 *
 * Source resolution prefers the built `dist/skills/` (production install
 * via `npm i -g`), then falls back to the repo's `apps/bot/skills/` for
 * `pnpm dev:bot` where tsc never ran. Returns gracefully when neither
 * exists rather than crashing the bot.
 */

const TARGETS = [
  { agent: "claude", root: join(homedir(), ".claude", "skills") },
  { agent: "codex", root: join(homedir(), ".codex", "skills") }
] as const;

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
  path: string;
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

  for (const skillName of entries) {
    const skillSrcDir = join(sourceDir, skillName);
    let srcStat;
    try {
      srcStat = await stat(skillSrcDir);
    } catch {
      continue;
    }
    if (!srcStat.isDirectory()) continue;

    const skillFile = join(skillSrcDir, "SKILL.md");
    if (!existsSync(skillFile)) {
      logger().debug({ skillName }, "skillInstaller: skill dir has no SKILL.md, skipping");
      continue;
    }

    let srcBody: Buffer;
    try {
      srcBody = await readFile(skillFile);
    } catch (err) {
      logger().warn({ skillName, err }, "skillInstaller: failed to read source SKILL.md");
      continue;
    }

    for (const target of targets) {
      const report = await installOneSkill(target, skillName, srcBody, options.force === true);
      reports.push(report);
      if (report.action === "created" || report.action === "updated") {
        logger().info(
          { skillName, agent: report.agent, path: report.path, action: report.action },
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

async function installOneSkill(
  target: { agent: string; root: string },
  skillName: string,
  srcBody: Buffer,
  force: boolean
): Promise<SkillInstallReport> {
  const dstDir = join(target.root, skillName);
  const dstFile = join(dstDir, "SKILL.md");

  try {
    await mkdir(dstDir, { recursive: true });
  } catch (err) {
    return {
      skillName,
      agent: target.agent,
      action: "error",
      path: dstFile,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  let existing: Buffer | null = null;
  try {
    existing = await readFile(dstFile);
  } catch {
    // Missing is the normal first-install case.
  }

  if (!force && existing && existing.equals(srcBody)) {
    return { skillName, agent: target.agent, action: "unchanged", path: dstFile };
  }

  try {
    await writeFile(dstFile, srcBody);
  } catch (err) {
    return {
      skillName,
      agent: target.agent,
      action: "error",
      path: dstFile,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  return {
    skillName,
    agent: target.agent,
    action: existing ? "updated" : "created",
    path: dstFile
  };
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
