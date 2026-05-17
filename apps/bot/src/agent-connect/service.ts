import { Config, sanitizeSensitiveEnv } from "./config.js";
import { SqliteConfigStore } from "./configStore.js";
import { hookRouterRegistry, MultiBotRuntimeManager } from "./multiBotRuntime.js";
import { proxyConfigLabel, setupHttpProxyFromEnv } from "./proxy.js";
import {
  readRuntimeJson,
  removeRuntimeJson,
  tcpProbe,
  writeRuntimeJson
} from "./runtimeJson.js";
import { startServer, type RuntimeState } from "./server.js";
import { agentConnectDir } from "./utils.js";

export interface RunBotServiceOptions {
  hookEntrypoint?: string;
}

export async function runBotService(
  env: NodeJS.ProcessEnv = process.env,
  options: RunBotServiceOptions = {}
): Promise<void> {
  const config = new Config(env, { requireTelegramConfig: false, sanitizeProcessEnv: false });
  const proxyConfig = setupHttpProxyFromEnv(env);
  if (proxyConfig.enabled) {
    console.info(`HTTP proxy enabled: ${proxyConfigLabel(proxyConfig)}`);
  }

  const runtimeDir = agentConnectDir(env);
  const existingRuntime = await readRuntimeJson(runtimeDir);
  if (existingRuntime && (await tcpProbe(existingRuntime.httpHost, existingRuntime.httpPort, 500))) {
    throw new Error(
      `another agent-connect service is running at ${existingRuntime.httpHost}:${existingRuntime.httpPort} (pid ${existingRuntime.pid})`
    );
  }

  if (config.enableMonitor) {
    await syncAgentHooks(env, options.hookEntrypoint);
  }
  const configStore = new SqliteConfigStore(config.databaseFile);
  configStore.ensureDefaultBotFromEnv(env);
  sanitizeSensitiveEnv();
  const runtimeState: RuntimeState = {
    startedAt: new Date().toISOString(),
    botReady: false,
    activeBots: 0
  };

  const multiBotRuntime = new MultiBotRuntimeManager(config, configStore);
  const server = await startServer(config, runtimeState, {
    ...(config.enableTelegram ? { configStore, runtimeManager: multiBotRuntime } : { configStore }),
    hookRouterLookup: (tmuxSession) => hookRouterRegistry.get(tmuxSession) ?? null
  });
  await writeRuntimeJson(runtimeDir, {
    httpHost: config.httpHost,
    httpPort: config.httpPort,
    pid: process.pid
  });
  runtimeState.botReady = true;

  if (config.enableTelegram) {
    void multiBotRuntime.startEnabled().finally(() => {
      runtimeState.activeBots = multiBotRuntime.activeCount();
    });
  }

  const shutdown = async (): Promise<void> => {
    runtimeState.botReady = false;
    await multiBotRuntime.stopAll();
    configStore.close();
    await server.close();
    await removeRuntimeJson(runtimeDir);
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function syncAgentHooks(env: NodeJS.ProcessEnv, hookEntrypoint?: string): Promise<void> {
  try {
    const { installCodexHook, installHook } = await import("./hookInstaller.js");
    const hookOptions = hookEntrypoint ? { env, entrypoint: hookEntrypoint } : { env };
    const claudeResult = await installHook({
      ...hookOptions
    });
    if (claudeResult.code !== 0) {
      console.warn(claudeResult.message);
    } else if (!claudeResult.message.includes("already synchronized")) {
      console.info(claudeResult.message);
    }

    const codexResult = await installCodexHook({
      ...hookOptions
    });
    if (codexResult.code !== 0) {
      console.warn(codexResult.message);
    } else if (!codexResult.message.includes("already synchronized")) {
      console.info(codexResult.message);
    }
  } catch (error) {
    console.warn("Failed to synchronize agent SessionStart hooks.", error);
  }
}
