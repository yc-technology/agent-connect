// Dev-only smoke test for the pino-roll rotation config. Writes a couple
// of log lines into /tmp/agc-log-test and prints the resulting filenames
// + symlink so you can eyeball that rotation looks right.
//
// Run: `cd apps/bot && node scripts/smoke-logger.mjs`
// (not wired to any package script — invoke manually when you change
// logger.ts).

import pino from "pino";
import { mkdirSync, readdirSync, statSync, lstatSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = "/tmp/agc-log-test";
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const transport = pino.transport({
  targets: [
    {
      target: "pino-roll",
      level: "info",
      options: {
        file: join(dir, "agent-connect.log"),
        frequency: "daily",
        dateFormat: "yyyy-MM-dd",
        mkdir: true,
        size: "50m",
        symlink: true
      }
    }
  ]
});

const log = pino({ level: "info" }, transport);
log.info({ test: 1 }, "hello rotation");
log.warn({ test: 2 }, "second line");

await new Promise((r) => setTimeout(r, 800));

console.log("Files in", dir, ":");
for (const f of readdirSync(dir)) {
  const full = join(dir, f);
  const lst = lstatSync(full);
  if (lst.isSymbolicLink()) {
    const target = (await import("node:fs")).readlinkSync(full);
    console.log(" -", f, "→ symlink →", target);
  } else {
    console.log(" -", f, statSync(full).size + "B");
  }
}
