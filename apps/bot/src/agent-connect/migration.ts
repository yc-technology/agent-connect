import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dbTransaction, openDatabase } from "./db.js";
import { logger } from "./logger.js";
import { SessionRegistry } from "./sessionRegistry.js";
import type { AgentType } from "./hookTypes.js";

interface StateJson {
  window_states?: Record<string, { session_id?: string; cwd?: string; window_name?: string }>;
  window_display_names?: Record<string, string>;
  thread_bindings?: Record<string, Record<string, string>>;
  group_chat_ids?: Record<string, number>;
  topic_probe_message_ids?: Record<string, number>;
  user_window_offsets?: Record<string, Record<string, number>>;
}

interface SessionMapJson {
  [key: string]: { session_id?: string; cwd?: string; window_name?: string } | undefined;
}

interface MonitorStateJson {
  tracked_sessions?: Record<
    string,
    { session_id?: string; file_path?: string; last_byte_offset?: number }
  >;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function migrateJsonToSqliteIfNeeded(
  botDir: string,
  tmuxSessionName: string,
  agentType: AgentType = "claude"
): Promise<void> {
  const dbPath = join(botDir, "bot.sqlite");
  if (existsSync(dbPath)) return;

  const stateFile = join(botDir, "state.json");
  const sessionMapFile = join(botDir, "session_map.json");
  const monitorStateFile = join(botDir, "monitor_state.json");
  const hasAnyJson =
    existsSync(stateFile) || existsSync(sessionMapFile) || existsSync(monitorStateFile);

  const db = openDatabase(dbPath);
  const registry = new SessionRegistry(db);

  if (!hasAnyJson) {
    db.close();
    return;
  }

  const state = (await readJsonOrNull<StateJson>(stateFile)) ?? {};
  const sessionMap = (await readJsonOrNull<SessionMapJson>(sessionMapFile)) ?? {};
  const monitorState = (await readJsonOrNull<MonitorStateJson>(monitorStateFile)) ?? {};

  const prefix = `${tmuxSessionName}:`;
  const tx = dbTransaction(db, () => {
    const displayNames = state.window_display_names ?? {};
    for (const [windowId, name] of Object.entries(displayNames)) {
      if (!windowId.startsWith("@")) continue;
      const cwd =
        state.window_states?.[windowId]?.cwd ??
        sessionMap[`${prefix}${windowId}`]?.cwd ??
        "";
      if (!cwd) continue;
      registry.upsertWindow(windowId, name, cwd);
    }

    for (const [key, info] of Object.entries(sessionMap)) {
      if (!key.startsWith(prefix) || !info) continue;
      const windowId = key.slice(prefix.length);
      if (!windowId.startsWith("@") || !info.session_id || !info.cwd) continue;
      if (!registry.listLiveWindows().some((w) => w.window_id === windowId)) {
        registry.upsertWindow(windowId, info.window_name ?? windowId, info.cwd);
      }
      const tracked = monitorState.tracked_sessions?.[info.session_id];
      registry.registerSession({
        sessionId: info.session_id,
        windowId,
        agentType,
        transcriptPath: tracked?.file_path ?? "",
        cwd: info.cwd,
        source: "startup",
        lastByteOffset: tracked?.last_byte_offset ?? 0
      });
    }

    for (const [userKey, bindings] of Object.entries(state.thread_bindings ?? {})) {
      const userId = Number(userKey);
      if (!Number.isFinite(userId)) continue;
      for (const [threadKey, windowId] of Object.entries(bindings)) {
        const threadId = Number(threadKey);
        if (!Number.isFinite(threadId)) continue;
        if (!registry.listLiveWindows().some((w) => w.window_id === windowId)) continue;
        registry.bindThread(userId, threadId, windowId);
        const chatKey = `${userId}:${threadId}`;
        const chatId = state.group_chat_ids?.[chatKey];
        if (typeof chatId === "number") registry.setGroupChatId(userId, threadId, chatId);
        const probeId = state.topic_probe_message_ids?.[chatKey];
        if (typeof probeId === "number") registry.setTopicProbeMessageId(userId, threadId, probeId);
      }
    }

    for (const [userKey, offsets] of Object.entries(state.user_window_offsets ?? {})) {
      const userId = Number(userKey);
      if (!Number.isFinite(userId)) continue;
      for (const [windowId, offset] of Object.entries(offsets)) {
        if (!registry.listLiveWindows().some((w) => w.window_id === windowId)) continue;
        registry.updateUserWindowOffset(userId, windowId, Number(offset));
      }
    }

    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
      "migrated_from_json_at",
      String(Date.now())
    );
  });

  try {
    tx();
  } catch (error) {
    db.close();
    await rm(dbPath, { force: true });
    logger().error({ dbPath, err: error }, "legacy JSON → SQLite migration FAILED, dropped partial db");
    throw error;
  }
  db.close();

  const stamp = todayStamp();
  const renamed: string[] = [];
  for (const path of [stateFile, sessionMapFile, monitorStateFile]) {
    if (existsSync(path)) {
      await rename(path, `${path}.migrated-${stamp}`);
      renamed.push(path);
    }
  }
  logger().info(
    { dbPath, renamedJsonFiles: renamed, stamp },
    "legacy JSON → SQLite migration completed (one-shot)"
  );
}
