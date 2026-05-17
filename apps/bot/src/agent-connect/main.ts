#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runBotService } from "./service.js";

async function main(): Promise<void> {
  if (process.argv[2] === "hook") {
    const { hookMain } = await import("./hook.js");
    process.exitCode = await hookMain(process.argv.slice(2));
    return;
  }

  await runBotService(process.env, {
    hookEntrypoint: fileURLToPath(import.meta.url)
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
