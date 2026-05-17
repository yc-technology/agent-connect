import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config } from "../src/agent-connect/config.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: "test:token",
    ALLOWED_USERS: "12345",
    AGENT_CONNECT_DIR: mkdtempSync(join(tmpdir(), "agent-connect-test-"))
  };
}

describe("Config", () => {
  it("loads required env vars", () => {
    const env = baseEnv();
    try {
      const config = new Config(env);
      expect(config.telegramBotToken).toBe("test:token");
      expect(config.isUserAllowed(12345)).toBe(true);
      expect(config.isUserAllowed(99999)).toBe(false);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("validates allowed users", () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv(), ALLOWED_USERS: "abc" };
    try {
      expect(() => new Config(env)).toThrow(/non-numeric/);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("starts Telegram polling by default", () => {
    const env = baseEnv();
    try {
      const config = new Config(env);
      expect(config.enableTelegram).toBe(true);
      expect(config.enableMonitor).toBe(true);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("hides intermediate messages by default and can enable them from env", () => {
    const env = baseEnv();
    const enabledEnv: NodeJS.ProcessEnv = {
      ...baseEnv(),
      AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES: "true"
    };
    try {
      expect(new Config(env).showToolCalls).toBe(false);
      expect(new Config(enabledEnv).showToolCalls).toBe(true);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
      rmSync(enabledEnv.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("can disable Telegram polling for management-only mode", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      AGENT_CONNECT_TS_ENABLE_TELEGRAM: "false"
    };
    try {
      const config = new Config(env);
      expect(config.enableTelegram).toBe(false);
      expect(config.enableMonitor).toBe(false);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("configures topic probe interval", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      AGENT_CONNECT_TOPIC_PROBE_INTERVAL: "0"
    };
    try {
      const config = new Config(env);
      expect(config.topicProbeInterval).toBe(0);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("falls back when topic probe interval is invalid", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      AGENT_CONNECT_TOPIC_PROBE_INTERVAL: "not-a-number"
    };
    try {
      const config = new Config(env);
      expect(config.topicProbeInterval).toBe(60);
    } finally {
      rmSync(env.AGENT_CONNECT_DIR!, { recursive: true, force: true });
    }
  });

  it("loads workspace root .env when running from apps/bot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agent-connect-workspace-env-test-"));
    const botDir = join(workspace, "apps", "bot");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(workspace, ".env"), "export HTTP_PROXY=http://127.0.0.1:7890/\n", "utf8");
    const env: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: "test:token",
      ALLOWED_USERS: "12345",
      AGENT_CONNECT_DIR: join(workspace, ".agent-connect")
    };

    try {
      process.chdir(botDir);
      new Config(env);
      expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890/");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses AGENT_CONNECT_DIR from workspace .env for state and database paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agent-connect-dir-env-test-"));
    const botDir = join(workspace, "apps", "bot");
    const configDir = join(workspace, "custom-config");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(
      join(workspace, ".env"),
      [
        `AGENT_CONNECT_DIR=${configDir}`,
        "TELEGRAM_BOT_TOKEN=test:token",
        "ALLOWED_USERS=12345"
      ].join("\n"),
      "utf8"
    );
    const env: NodeJS.ProcessEnv = {};

    try {
      process.chdir(botDir);
      const config = new Config(env, { sanitizeProcessEnv: false });
      expect(config.configDir).toBe(configDir);
      expect(config.databaseFile).toBe(join(configDir, "agent-connect.sqlite"));
      expect(config.stateFile).toBe(join(configDir, "state.json"));
      expect(config.sessionMapFile).toBe(join(configDir, "session_map.json"));
      expect(config.telegramBotToken).toBe("test:token");
      expect(config.isUserAllowed(12345)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
