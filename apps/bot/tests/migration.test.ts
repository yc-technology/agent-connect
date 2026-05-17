import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateJsonToSqliteIfNeeded } from "../src/agent-connect/migration.js";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";

let botDir: string;
beforeEach(() => {
  botDir = mkdtempSync(join(tmpdir(), "agc-migration-"));
});

function writeFixtures(args: {
  state?: unknown;
  sessionMap?: unknown;
  monitorState?: unknown;
}): void {
  if (args.state) {
    writeFileSync(join(botDir, "state.json"), JSON.stringify(args.state));
  }
  if (args.sessionMap) {
    writeFileSync(join(botDir, "session_map.json"), JSON.stringify(args.sessionMap));
  }
  if (args.monitorState) {
    writeFileSync(join(botDir, "monitor_state.json"), JSON.stringify(args.monitorState));
  }
}

describe("migrateJsonToSqliteIfNeeded", () => {
  test("no-op when bot.sqlite already exists", async () => {
    new Database(join(botDir, "bot.sqlite")).close();
    writeFixtures({
      state: { window_states: { "@0": { session_id: "S", cwd: "/a", window_name: "x" } } }
    });
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    expect(existsSync(join(botDir, "state.json"))).toBe(true);
  });

  test("creates schema and skips import when no JSON files", async () => {
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    expect(existsSync(join(botDir, "bot.sqlite"))).toBe(true);
    const db = new Database(join(botDir, "bot.sqlite"));
    const reg = new SessionRegistry(db);
    expect(reg.listLiveWindows()).toEqual([]);
    db.close();
  });

  test("imports windows + sessions + bindings from JSON fixtures", async () => {
    writeFixtures({
      state: {
        window_states: { "@0": { session_id: "S1", cwd: "/proj", window_name: "proj" } },
        window_display_names: { "@0": "proj" },
        thread_bindings: { "123": { "42": "@0" } },
        group_chat_ids: { "123:42": -100200 },
        topic_probe_message_ids: { "123:42": 555 },
        user_window_offsets: { "123": { "@0": 4096 } }
      },
      sessionMap: {
        "tmux-test:@0": { session_id: "S1", cwd: "/proj", window_name: "proj" }
      },
      monitorState: {
        tracked_sessions: {
          S1: { session_id: "S1", file_path: "/path/S1.jsonl", last_byte_offset: 8192 }
        }
      }
    });

    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");

    const reg = new SessionRegistry(new Database(join(botDir, "bot.sqlite")));
    expect(reg.listLiveWindows()).toMatchObject([
      { window_id: "@0", display_name: "proj", cwd: "/proj" }
    ]);
    expect(reg.getSessionByWindow("@0")).toMatchObject({
      session_id: "S1",
      transcript_path: "/path/S1.jsonl",
      last_byte_offset: 8192,
      cwd: "/proj"
    });
    expect(reg.resolveWindowForThread(123, 42)).toBe("@0");
    expect(reg.resolveChatId(123, 42)).toBe(-100200);
    expect(reg.getTopicProbeMessageId(123, 42)).toBe(555);
    expect(reg.getUserWindowOffset(123, "@0")).toBe(4096);
  });

  test("renames JSON files with .migrated-YYYY-MM-DD suffix", async () => {
    writeFixtures({ state: { window_display_names: {} } });
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    const files = readdirSync(botDir);
    expect(files.some((f) => f.startsWith("state.json.migrated-"))).toBe(true);
    expect(files.includes("state.json")).toBe(false);
  });

  test("running migration twice is a no-op (bot.sqlite already exists)", async () => {
    writeFixtures({
      state: {
        window_display_names: { "@0": "x" },
        window_states: { "@0": { session_id: "", cwd: "/a", window_name: "x" } }
      }
    });
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    await migrateJsonToSqliteIfNeeded(botDir, "tmux-test");
    const files = readdirSync(botDir);
    expect(files.filter((f) => f.startsWith("state.json.migrated-"))).toHaveLength(1);
  });
});
