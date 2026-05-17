#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runBotService } from "./service.js";

async function main(): Promise<void> {
  if (process.argv[2] === "hook") {
    const rest = process.argv.slice(3);
    if (rest.includes("--install")) {
      const { installAllHooks } = await import("./hookInstaller.js");
      const result = await installAllHooks();
      (result.code === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
      process.exitCode = result.code;
      return;
    }
    const { runHookClient } = await import("./hookClient.js");
    process.exitCode = await runHookClient();
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
