// Copy the freshly built web app into the bot's dist tree so that:
//   1. `agc start` from a local pnpm build can serve the web at /
//   2. The npm-published `@yc-tech/agent-connect-bot` package includes the
//      web (via files: ["dist"]) and `agc start --daemon` works out of the
//      box on a fresh install.
//
// Sequence wired in apps/bot/package.json:
//   build = rm dist → vite-build-web → tsc bot → THIS
// `tsc` recreates `dist/` after the rm; we copy into the populated dist
// AFTER tsc so the web files land alongside the compiled JS. At runtime
// `server.ts` checks `existsSync(<dist>/web/index.html)` and skips static
// registration if missing (e.g. `pnpm dev:bot` users who didn't build).

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "web", "dist");
const dst = resolve(here, "..", "dist", "web");

if (!existsSync(src)) {
  // Build didn't produce a web dist (rare — would mean vite step skipped).
  // Don't crash the whole bot build; just no-op so dev work continues.
  console.warn(`[copy-web-dist] source ${src} missing — skipping web copy`);
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

console.log(`[copy-web-dist] copied ${src} → ${dst}`);
