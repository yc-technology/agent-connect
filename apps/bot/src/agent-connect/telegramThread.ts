export const PRIVATE_CHAT_THREAD_ID = 0;

export function isForumThreadId(threadId: number | null | undefined): threadId is number {
  return typeof threadId === "number" && threadId > 1;
}

export function threadOptions(threadId: number | null | undefined): Record<string, unknown> {
  return isForumThreadId(threadId) ? { message_thread_id: threadId } : {};
}
