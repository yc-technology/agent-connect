import { stat } from "node:fs/promises";
import { buildResponseParts } from "./responseBuilder.js";
import type { Config } from "./config.js";
import type { NewMessageLike } from "./drainTranscript.js";
import { MessageQueueManager } from "./messageQueue.js";
import type { SessionManager } from "./session.js";

export type NewMessage = NewMessageLike;

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

  // Image-bearing tool_results bypass the suppression gate: even when
  // showToolCalls=false (default), users explicitly want to see screenshots
  // / Claude's image output in Telegram. Text-only tool_use / tool_result /
  // thinking / local_command still collapse to a "Thinking…" status to
  // avoid spamming the chat with every Read/Bash invocation.
  const hasImage = !!(msg.imageData && msg.imageData.length > 0);

  for (const [userId, windowId, threadId] of activeUsers) {
    if (!deps.config.showToolCalls && isIntermediateContent(msg.contentType) && !hasImage) {
      deps.messageQueue.enqueueStatusUpdate(userId, windowId, THINKING_STATUS_TEXT, threadId);
      await deps.messageQueue.drain(userId);
      continue;
    }

    const parts = buildResponseParts(msg.text, msg.isComplete, msg.contentType, msg.role);
    if (!msg.isComplete) continue;

    if (!deps.config.showToolCalls && msg.role === "assistant" && msg.contentType === "text") {
      deps.messageQueue.enqueueStatusUpdate(userId, windowId, null, threadId);
    }
    // When the only thing we want to surface is the image (text-suppressed
    // tool_result), substitute a compact caption for `parts` so Telegram
    // gets a captioned photo instead of a naked one. Falls back to the
    // tool name (or a generic camera) when no summary is available.
    const useImageOnlyCaption =
      hasImage && !deps.config.showToolCalls && isIntermediateContent(msg.contentType);
    const sendParts = useImageOnlyCaption
      ? [imageCaption(msg.toolName ?? null, msg.text)]
      : parts;
    deps.messageQueue.enqueueContentMessage(userId, windowId, sendParts, {
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

function imageCaption(toolName: string | null, text: string): string {
  // tool_result text often duplicates "[Image]" sentinels or is empty —
  // prefer the tool name when present. Telegram caption is bounded at
  // 1024 chars so a short, fixed prefix is fine.
  if (toolName && toolName.trim()) return `📷 ${toolName.trim()}`;
  const cleaned = text?.trim();
  if (cleaned && cleaned.length <= 200) return `📷 ${cleaned}`;
  return "📷";
}
