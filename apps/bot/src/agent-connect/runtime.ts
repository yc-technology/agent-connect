import { stat } from "node:fs/promises";
import { buildResponseParts } from "./responseBuilder.js";
import type { Config } from "./config.js";
import { MessageQueueManager } from "./messageQueue.js";
import type { NewMessage, SessionMonitor } from "./sessionMonitor.js";
import type { SessionManager } from "./session.js";

export interface RuntimeDeps {
  config: Pick<Config, "showToolCalls" | "showUserMessages">;
  sessionManager: Pick<
    SessionManager,
    "findUsersForWindow" | "resolveSessionForWindow" | "updateUserWindowOffset"
  >;
  messageQueue: Pick<MessageQueueManager, "enqueueContentMessage" | "enqueueStatusUpdate" | "drain">;
}

const THINKING_STATUS_TEXT = "Thinking...";
const INTERMEDIATE_CONTENT_TYPES = new Set(["thinking", "tool_use", "tool_result", "local_command"]);

export async function handleNewMessage(msg: NewMessage, deps: RuntimeDeps): Promise<void> {
  if (msg.role === "user" && !deps.config.showUserMessages) return;

  if (!msg.windowId) return;
  const activeUsers = deps.sessionManager.findUsersForWindow(msg.windowId);
  if (activeUsers.length === 0) return;

  for (const [userId, windowId, threadId] of activeUsers) {
    if (!deps.config.showToolCalls && isIntermediateContent(msg.contentType)) {
      deps.messageQueue.enqueueStatusUpdate(userId, windowId, THINKING_STATUS_TEXT, threadId);
      await deps.messageQueue.drain(userId);
      continue;
    }

    const parts = buildResponseParts(msg.text, msg.isComplete, msg.contentType, msg.role);
    if (!msg.isComplete) continue;

    if (!deps.config.showToolCalls && msg.role === "assistant" && msg.contentType === "text") {
      deps.messageQueue.enqueueStatusUpdate(userId, windowId, null, threadId);
    }
    deps.messageQueue.enqueueContentMessage(userId, windowId, parts, {
      toolUseId: msg.toolUseId ?? null,
      contentType: msg.contentType,
      role: msg.role,
      text: msg.text,
      threadId,
      imageData: msg.imageData ?? null
    });
    await deps.messageQueue.drain(userId);

    const session = await deps.sessionManager.resolveSessionForWindow(windowId);
    if (session?.filePath) {
      try {
        const fileStat = await stat(session.filePath);
        deps.sessionManager.updateUserWindowOffset(userId, windowId, fileStat.size);
      } catch {
        // Session file may disappear during /clear or shutdown; skip offset update.
      }
    }
  }
}

function isIntermediateContent(contentType: string): boolean {
  return INTERMEDIATE_CONTENT_TYPES.has(contentType);
}

export function wireMonitorToQueue(monitor: SessionMonitor, deps: RuntimeDeps): void {
  monitor.setMessageCallback((message) => handleNewMessage(message, deps));
}
