import {
  editWithFallback,
  sendPhoto,
  sendWithFallback,
  type TelegramApiLike
} from "./messageSender.js";
import { isForumThreadId, threadOptions } from "./telegramThread.js";
import type { ToolResultImage } from "./transcriptParser.js";

export type MessageTaskType = "content" | "status_update" | "status_clear";
export type MessageTaskRole = "user" | "assistant";

export interface MessageTask {
  taskType: MessageTaskType;
  text?: string | null;
  windowId?: string | null;
  parts: string[];
  toolUseId?: string | null;
  contentType: string;
  role?: MessageTaskRole | null;
  threadId?: number | null;
  imageData?: ToolResultImage[] | null;
}

export interface SessionRoutingLike {
  resolveChatId(userId: number, threadId?: number | null): number;
  setTopicProbeMessageId?(userId: number, threadId: number, messageId: number): void;
}

export const MERGE_MAX_LENGTH = 3800;

type ToolKey = `${string}:${number}:${number}`;
type StatusKey = `${number}:${number}`;

export class MessageQueueManager {
  private readonly queues = new Map<number, MessageTask[]>();
  private readonly processing = new Set<number>();
  private readonly toolMessageIds = new Map<ToolKey, number>();
  private readonly statusMessageInfo = new Map<StatusKey, { messageId: number; windowId: string; text: string }>();
  // Tracks the id of the most recent assistant TEXT message sent per (user, thread).
  // HookRouter's onTurnEnd reads this to attach a "turn done" reaction. We only
  // record text-role assistant sends — never tool_use / tool_result / thinking —
  // so the reaction always lands on the final spoken reply for that topic.
  private readonly lastAssistantMessageIds = new Map<StatusKey, number>();

  constructor(
    private readonly api: TelegramApiLike,
    private readonly routing: SessionRoutingLike
  ) {}

  getQueue(userId: number): MessageTask[] | null {
    return this.queues.get(userId) ?? null;
  }

  enqueueContentMessage(
    userId: number,
    windowId: string,
    parts: string[],
    options: {
      toolUseId?: string | null;
      contentType?: string;
      role?: MessageTaskRole;
      text?: string | null;
      threadId?: number | null;
      imageData?: ToolResultImage[] | null;
    } = {}
  ): void {
    this.enqueue(userId, {
      taskType: "content",
      text: options.text ?? null,
      windowId,
      parts,
      toolUseId: options.toolUseId ?? null,
      contentType: options.contentType ?? "text",
      role: options.role ?? "assistant",
      threadId: options.threadId ?? null,
      imageData: options.imageData ?? null
    });
  }

  enqueueStatusUpdate(
    userId: number,
    windowId: string,
    statusText: string | null,
    threadId: number | null = null
  ): void {
    const tid = threadId ?? 0;
    if (statusText) {
      const info = this.statusMessageInfo.get(statusKey(userId, tid));
      if (info && info.windowId === windowId && info.text === statusText) return;
      this.enqueue(userId, {
        taskType: "status_update",
        text: statusText,
        windowId,
        parts: [],
        contentType: "text",
        threadId
      });
      return;
    }

    this.enqueue(userId, {
      taskType: "status_clear",
      parts: [],
      contentType: "text",
      threadId
    });
  }

  async drain(userId: number): Promise<void> {
    if (this.processing.has(userId)) return;
    this.processing.add(userId);
    try {
      const queue = this.queues.get(userId);
      while (queue && queue.length > 0) {
        const task = queue.shift()!;
        if (task.taskType === "content") {
          const merged = this.mergeContentTasks(task, queue);
          await this.processContentTask(userId, merged);
        } else if (task.taskType === "status_update") {
          await this.processStatusUpdateTask(userId, task);
        } else {
          await this.clearStatusMessage(userId, task.threadId ?? 0);
        }
      }
    } finally {
      this.processing.delete(userId);
    }
  }

  clearStatusMsgInfo(userId: number, threadId: number | null = null): void {
    this.statusMessageInfo.delete(statusKey(userId, threadId ?? 0));
  }

  clearToolMsgIdsForTopic(userId: number, threadId: number | null = null): void {
    const tid = threadId ?? 0;
    for (const key of [...this.toolMessageIds.keys()]) {
      const [, keyUserId, keyThreadId] = key.split(":");
      if (Number(keyUserId) === userId && Number(keyThreadId) === tid) {
        this.toolMessageIds.delete(key);
      }
    }
  }

  getToolMessageId(toolUseId: string, userId: number, threadId: number | null = null): number | null {
    return this.toolMessageIds.get(toolKey(toolUseId, userId, threadId ?? 0)) ?? null;
  }

  getStatusMessageInfo(userId: number, threadId: number | null = null) {
    return this.statusMessageInfo.get(statusKey(userId, threadId ?? 0)) ?? null;
  }

  getLastAssistantMessageId(userId: number, threadId: number | null = null): number | null {
    return this.lastAssistantMessageIds.get(statusKey(userId, threadId ?? 0)) ?? null;
  }

  clearLastAssistantMessageId(userId: number, threadId: number | null = null): void {
    this.lastAssistantMessageIds.delete(statusKey(userId, threadId ?? 0));
  }

  private enqueue(userId: number, task: MessageTask): void {
    const queue = this.queues.get(userId) ?? [];
    queue.push(task);
    this.queues.set(userId, queue);
  }

  private mergeContentTasks(first: MessageTask, queue: MessageTask[]): MessageTask {
    const mergedParts = [...first.parts];
    let currentLength = mergedParts.reduce((acc, part) => acc + part.length, 0);
    let consumed = 0;

    for (const task of queue) {
      if (!canMergeTasks(first, task)) break;
      const taskLength = task.parts.reduce((acc, part) => acc + part.length, 0);
      if (currentLength + taskLength > MERGE_MAX_LENGTH) break;
      mergedParts.push(...task.parts);
      currentLength += taskLength;
      consumed += 1;
    }

    if (consumed > 0) queue.splice(0, consumed);
    return consumed === 0
      ? first
      : {
          ...first,
          parts: mergedParts
        };
  }

  private async processContentTask(userId: number, task: MessageTask): Promise<void> {
    const windowId = task.windowId ?? "";
    const threadId = task.threadId ?? null;
    const tid = threadId ?? 0;
    const chatId = this.routing.resolveChatId(userId, threadId);

    if (task.contentType === "tool_result" && task.toolUseId) {
      const key = toolKey(task.toolUseId, userId, tid);
      const editMessageId = this.toolMessageIds.get(key);
      if (editMessageId !== undefined) {
        this.toolMessageIds.delete(key);
        await this.clearStatusMessage(userId, tid);
        const fullText = task.parts.join("\n\n");
        const edited = await editWithFallback(
          this.api,
          chatId,
          editMessageId,
          fullText,
          sendOptions(threadId)
        );
        if (edited) {
          await this.sendTaskImages(chatId, task);
          return;
        }
      }
    }

    let firstPart = true;
    let lastMessageId: number | null = null;
    for (const part of task.parts) {
      if (firstPart) {
        firstPart = false;
        const converted = await this.convertStatusToContent(userId, tid, windowId, part);
        if (converted !== null) {
          lastMessageId = converted;
          this.recordTopicProbeMessageId(userId, threadId, converted);
          continue;
        }
      }

      const sent = await sendWithFallback(this.api, chatId, part, sendOptions(threadId));
      if (sent) {
        lastMessageId = sent.message_id;
        this.recordTopicProbeMessageId(userId, threadId, sent.message_id);
      }
    }

    if (lastMessageId && task.toolUseId && task.contentType === "tool_use") {
      this.toolMessageIds.set(toolKey(task.toolUseId, userId, tid), lastMessageId);
    }

    if (lastMessageId && task.role === "assistant" && task.contentType === "text") {
      this.lastAssistantMessageIds.set(statusKey(userId, tid), lastMessageId);
    }

    await this.sendTaskImages(chatId, task);
  }

  private async processStatusUpdateTask(userId: number, task: MessageTask): Promise<void> {
    const windowId = task.windowId ?? "";
    const threadId = task.threadId ?? null;
    const tid = threadId ?? 0;
    const text = task.text ?? "";

    if (!text) {
      await this.clearStatusMessage(userId, tid);
      return;
    }

    const key = statusKey(userId, tid);
    const current = this.statusMessageInfo.get(key);
    const chatId = this.routing.resolveChatId(userId, threadId);

    if (!current) {
      await this.sendStatusMessage(userId, tid, windowId, text);
      return;
    }

    if (current.windowId !== windowId) {
      await this.clearStatusMessage(userId, tid);
      await this.sendStatusMessage(userId, tid, windowId, text);
      return;
    }

    if (current.text === text) return;

    const edited = await editWithFallback(this.api, chatId, current.messageId, text, sendOptions(threadId));
    if (edited) {
      this.statusMessageInfo.set(key, { messageId: current.messageId, windowId, text });
    } else {
      this.statusMessageInfo.delete(key);
      await this.sendStatusMessage(userId, tid, windowId, text);
    }
  }

  private async sendStatusMessage(userId: number, tid: number, windowId: string, text: string): Promise<void> {
    const threadId = tid === 0 ? null : tid;
    const chatId = this.routing.resolveChatId(userId, threadId);
    const old = this.statusMessageInfo.get(statusKey(userId, tid));
    if (old) await this.api.deleteMessage?.(chatId, old.messageId);

    if (text.toLowerCase().includes("esc to interrupt")) {
      await this.api.sendChatAction?.(chatId, "typing", sendOptions(threadId));
    }

    const sent = await sendWithFallback(this.api, chatId, text, sendOptions(threadId));
    if (sent) {
      this.statusMessageInfo.set(statusKey(userId, tid), {
        messageId: sent.message_id,
        windowId,
        text
      });
      this.recordTopicProbeMessageId(userId, threadId, sent.message_id);
    }
  }

  private async clearStatusMessage(userId: number, tid: number): Promise<void> {
    const key = statusKey(userId, tid);
    const info = this.statusMessageInfo.get(key);
    if (!info) return;
    this.statusMessageInfo.delete(key);
    const threadId = tid === 0 ? null : tid;
    const chatId = this.routing.resolveChatId(userId, threadId);
    await this.api.deleteMessage?.(chatId, info.messageId);
  }

  private async convertStatusToContent(
    userId: number,
    tid: number,
    windowId: string,
    contentText: string
  ): Promise<number | null> {
    const key = statusKey(userId, tid);
    const info = this.statusMessageInfo.get(key);
    if (!info) return null;

    this.statusMessageInfo.delete(key);
    const threadId = tid === 0 ? null : tid;
    const chatId = this.routing.resolveChatId(userId, threadId);

    if (info.windowId !== windowId) {
      await this.api.deleteMessage?.(chatId, info.messageId);
      return null;
    }

    const edited = await editWithFallback(this.api, chatId, info.messageId, contentText, sendOptions(threadId));
    if (edited) this.recordTopicProbeMessageId(userId, threadId, info.messageId);
    return edited ? info.messageId : null;
  }

  private async sendTaskImages(chatId: number, task: MessageTask): Promise<void> {
    if (!task.imageData?.length) return;
    await sendPhoto(this.api, chatId, task.imageData, sendOptions(task.threadId ?? null));
  }

  private recordTopicProbeMessageId(userId: number, threadId: number | null, messageId: number): void {
    if (!isForumThreadId(threadId)) return;
    this.routing.setTopicProbeMessageId?.(userId, threadId, messageId);
  }
}

export function canMergeTasks(base: MessageTask, candidate: MessageTask): boolean {
  if (base.windowId !== candidate.windowId) return false;
  if (candidate.taskType !== "content") return false;
  if ((base.role ?? null) !== (candidate.role ?? null)) return false;
  if (base.contentType !== candidate.contentType) return false;
  if (base.contentType === "tool_use" || base.contentType === "tool_result") return false;
  if (candidate.contentType === "tool_use" || candidate.contentType === "tool_result") return false;
  return true;
}

function sendOptions(threadId: number | null): Record<string, unknown> {
  return threadOptions(threadId);
}

function statusKey(userId: number, tid: number): StatusKey {
  return `${userId}:${tid}`;
}

function toolKey(toolUseId: string, userId: number, tid: number): ToolKey {
  return `${toolUseId}:${userId}:${tid}`;
}
