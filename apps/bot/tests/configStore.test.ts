import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteConfigStore } from "../src/agent-connect/configStore.js";

function withStore<T>(fn: (store: SqliteConfigStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "agent-connect-config-store-test-"));
  const store = new SqliteConfigStore(join(dir, "agent-connect.sqlite"));
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SqliteConfigStore", () => {
  it("creates, updates, finds, and deletes bot configs", () => {
    withStore((store) => {
      const bot = store.createBot({
        id: "ops",
        name: "Ops Bot",
        telegramBotToken: "token",
        allowedUsers: [123],
        tmuxSessionName: "agent-connect-ops"
      });

      expect(bot).toMatchObject({
        id: "ops",
        name: "Ops Bot",
        allowedUsers: [123],
        agentType: "claude",
        tmuxSessionName: "agent-connect-ops",
        claudeCommand: "claude --permission-mode bypassPermissions",
        showToolCalls: false,
        enabled: true
      });
      expect(store.findBotByTmuxSessionName("agent-connect-ops")?.id).toBe("ops");

      const updated = store.updateBot("ops", {
        name: "Updated",
        enabled: false
      });
      expect(updated).toMatchObject({ name: "Updated", enabled: false });
      expect(store.listEnabledBots()).toEqual([]);

      expect(store.deleteBot("ops")).toBe(true);
      expect(store.getBot("ops")).toBeNull();
    });
  });

  it("creates Codex bot configs with Codex defaults", () => {
    withStore((store) => {
      const bot = store.createBot({
        id: "codex",
        name: "Codex Bot",
        telegramBotToken: "token",
        allowedUsers: [123],
        agentType: "codex"
      });

      expect(bot).toMatchObject({
        id: "codex",
        agentType: "codex",
        claudeCommand: "codex --yolo"
      });
    });
  });

  it("seeds a default bot from legacy env config", () => {
    withStore((store) => {
      const seeded = store.ensureDefaultBotFromEnv({
        TELEGRAM_BOT_TOKEN: "legacy-token",
        ALLOWED_USERS: "100,200",
        TMUX_SESSION_NAME: "agent-connect"
      });

      expect(seeded).toMatchObject({
        id: "default",
        telegramBotToken: "legacy-token",
        allowedUsers: [100, 200],
        tmuxSessionName: "agent-connect",
        claudeCommand: "claude --permission-mode bypassPermissions",
        showToolCalls: false
      });
      expect(store.ensureDefaultBotFromEnv({ TELEGRAM_BOT_TOKEN: "other", ALLOWED_USERS: "1" })?.telegramBotToken).toBe(
        "legacy-token"
      );
    });
  });

  it("seeds intermediate messages from env aliases", () => {
    withStore((store) => {
      const seeded = store.ensureDefaultBotFromEnv({
        TELEGRAM_BOT_TOKEN: "legacy-token",
        ALLOWED_USERS: "100",
        AGENT_CONNECT_SHOW_INTERMEDIATE_MESSAGES: "true"
      });

      expect(seeded).toMatchObject({
        showToolCalls: true
      });
    });
  });
});
