// Copy the bundled skills tree into the bot's dist so that:
//   1. The npm-published `@yc-tech/agent-connect-bot` package includes the
//      skills (files: ["dist"]).
//   2. service.ts can locate them via a path relative to its own JS file
//      regardless of whether it runs from `dist/` (production) or from
//      `src/` via tsx (development).
//
// Mirror of copy-web-dist.mjs. Source: apps/bot/skills/. Destination:
// apps/bot/dist/skills/. Run after tsc so the dist tree exists.
//
// In dev (`pnpm dev:bot`) tsc never runs, so dist/skills won't exist.
// skillInstaller.ts handles that by also checking the repo-relative source
// path before giving up.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "skills");
const dst = resolve(here, "..", "dist", "skills");

if (!existsSync(src)) {
  console.warn(`[copy-skills] source ${src} missing — skipping skill copy`);
  process.exit(0);
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

function copyRecursive(srcDir, dstDir) {
  for (const entry of readdirSync(srcDir)) {
    const s = join(srcDir, entry);
    const d = join(dstDir, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}
copyRecursive(src, dst);

console.log(`[copy-skills] copied ${src} → ${dst}`);
