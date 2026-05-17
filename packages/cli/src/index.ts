#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { hookMain } from "@agent-connect/bot/hook";
import { runBotService } from "@agent-connect/bot/service";

const HELP_TEXT = `agc command line

Usage:
  agc start          Start the bot service and management API
  agc serve          Alias for start
  agc hook           Run the agent hook handler
  agc hook --install Install Claude and Codex hooks
  agc help           Show this help
`;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (command === "hook") {
    return hookMain(argv);
  }

  if (command === "hook:install") {
    return hookMain(["hook", "--install"]);
  }

  if (command === "start" || command === "serve" || command === "bot") {
    await runBotService(process.env, {
      hookEntrypoint: fileURLToPath(import.meta.url)
    });
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP_TEXT}`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }
);
