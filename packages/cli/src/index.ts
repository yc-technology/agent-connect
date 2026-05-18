#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runHookClient } from "@yc-tech/agent-connect-bot/hookClient";
import { installAllHooks } from "@yc-tech/agent-connect-bot/hookInstaller";
import { runBotService } from "@yc-tech/agent-connect-bot/service";

const HELP_TEXT = `agc command line

Usage:
  agc start          Start the bot service and management API
  agc serve          Alias for start
  agc hook           Run the agent hook handler
  agc hook --install Install Claude and Codex hooks
  agc help           Show this help
`;

async function runHook(argv: string[]): Promise<number> {
  const rest = argv[0] === "hook" ? argv.slice(1) : argv;
  if (rest.includes("--install")) {
    const result = await installAllHooks();
    (result.code === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
    return result.code;
  }
  return runHookClient();
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (command === "hook") {
    return runHook(argv);
  }

  if (command === "hook:install") {
    return runHook(["hook", "--install"]);
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
