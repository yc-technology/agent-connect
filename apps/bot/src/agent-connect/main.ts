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
  // Top-level fatal. Try to land in the rotating file too — but never let
  // a logger-init failure mask the real error, so write to stderr first.
  console.error(error);
  try {
    // Lazy import so a logger module crash doesn't prevent stderr above.
    void import("./logger.js").then(({ logger }) =>
      logger().fatal({ err: error }, "agent-connect fatal — exiting")
    );
  } catch {
    // ignored — stderr already has the error
  }
  process.exit(1);
});
