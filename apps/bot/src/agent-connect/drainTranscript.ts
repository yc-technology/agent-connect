import { open, stat } from "node:fs/promises";
import { TranscriptParser, type PendingToolInfo } from "./transcriptParser.js";
import type { SessionRegistry, SessionRow } from "./sessionRegistry.js";

export interface NewMessageLike {
  sessionId: string;
  windowId: string;
  text: string;
  isComplete: boolean;
  contentType: string;
  toolUseId?: string | null;
  role: "user" | "assistant";
  toolName?: string | null;
  imageData?: unknown;
}

export type Dispatcher = (windowId: string, entries: NewMessageLike[]) => Promise<void>;

const pendingToolsCache = new Map<string, Record<string, PendingToolInfo>>();

export function _resetPendingForTests(): void {
  pendingToolsCache.clear();
}

export async function drainTranscript(
  registry: SessionRegistry,
  dispatcher: Dispatcher,
  sessionId: string
): Promise<void> {
  if (!registry.getSession(sessionId)) return;

  return registry.withSessionLock(sessionId, async (session: SessionRow) => {
    if (!session.transcript_path) return;

    let info;
    try {
      info = await stat(session.transcript_path);
    } catch {
      return;
    }

    let startOffset = session.last_byte_offset;
    if (info.size < startOffset) {
      registry.setOffset(sessionId, 0);
      pendingToolsCache.delete(sessionId);
      startOffset = 0;
    }
    if (info.size <= startOffset) return;

    const buf = Buffer.alloc(info.size - startOffset);
    const handle = await open(session.transcript_path, "r");
    try {
      await handle.read(buf, 0, buf.length, startOffset);
    } finally {
      await handle.close();
    }

    let safeEnd = startOffset;
    const entries: Record<string, unknown>[] = [];
    let cursor = 0;
    while (cursor < buf.length) {
      const nl = buf.indexOf(0x0a, cursor);
      const lineEnd = nl === -1 ? buf.length : nl;
      const raw = buf.subarray(cursor, lineEnd).toString("utf8");
      const parsed = TranscriptParser.parseLine(raw);
      if (parsed) {
        entries.push(parsed);
        safeEnd = startOffset + lineEnd + (nl === -1 ? 0 : 1);
      } else if (raw.trim()) {
        break;
      } else {
        safeEnd = startOffset + lineEnd + (nl === -1 ? 0 : 1);
      }
      if (nl === -1) break;
      cursor = nl + 1;
    }

    const carry = pendingToolsCache.get(sessionId) ?? {};
    const [parsedEntries, remaining] = TranscriptParser.parseEntries(entries, carry);
    if (Object.keys(remaining).length > 0) {
      pendingToolsCache.set(sessionId, remaining);
    } else {
      pendingToolsCache.delete(sessionId);
    }

    registry.setOffset(sessionId, safeEnd);

    const messages: NewMessageLike[] = parsedEntries
      .filter((e) => e.text || e.imageData)
      .map((e) => ({
        sessionId,
        windowId: session.window_id,
        text: e.text,
        isComplete: true,
        contentType: e.contentType,
        toolUseId: e.toolUseId ?? null,
        role: e.role,
        toolName: e.toolName ?? null,
        imageData: e.imageData ?? null
      }));

    if (messages.length > 0) {
      await dispatcher(session.window_id, messages);
    }
  });
}
