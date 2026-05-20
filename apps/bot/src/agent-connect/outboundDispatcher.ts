import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { logger } from "./logger.js";
import type { MessageQueueManager } from "./messageQueue.js";
import type { SessionManager } from "./session.js";

/**
 * Outbound delivery path for caller-initiated sends — the inverse of
 * HookRouter which handles agent-initiated drains. Currently the only caller
 * is `agc send <path>` via POST /bot/send-file, but the shape is general:
 * deliver a Buffer-backed file to all users bound to a tmux window.
 *
 * Lives next to HookRouter in the multiBotRuntime per-instance set: same
 * lifecycle (created when bot starts, registered in outboundRegistry under
 * the tmux session name).
 */

// Telegram document upload cap. sendDocument rejects above this; the CLI
// + endpoint pre-flight against it for a clean error rather than letting
// the upload start and fail mid-flight.
const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

// Subset of common MIME types. The map's only real job is to set a sensible
// Content-Type so Telegram clients render the right icon / preview;
// unknown extensions fall back to application/octet-stream which TG accepts.
const MIME_MAP: Record<string, string> = {
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".7z": "application/x-7z-compressed",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

export interface SendFileRequest {
  windowId: string;
  path: string;
  caption?: string | null;
}

export interface SendFileResult {
  ok: boolean;
  status: number;
  error?: string;
  // Per-fanout accounting. `deliveries` counts the (user, thread) pairs we
  // enqueued; `failed` counts those whose drain rejected (TG outage, 429
  // exhaustion, network flap). `ok` is true iff at least one drain
  // succeeded — endpoint maps `ok=false` to 502.
  deliveries?: number;
  failed?: number;
  sizeBytes?: number;
  filename?: string;
}

export interface OutboundDispatcherDeps {
  sessionManager: Pick<SessionManager, "findUsersForWindow">;
  messageQueue: Pick<MessageQueueManager, "enqueueContentMessage" | "drain">;
}

export class OutboundDispatcher {
  constructor(private readonly deps: OutboundDispatcherDeps) {}

  async sendFile(req: SendFileRequest): Promise<SendFileResult> {
    if (!req.path || typeof req.path !== "string") {
      return { ok: false, status: 400, error: "path is required" };
    }
    if (!req.windowId) {
      return { ok: false, status: 400, error: "windowId is required" };
    }

    let fileStat;
    try {
      fileStat = await stat(req.path);
    } catch (err) {
      return {
        ok: false,
        status: 404,
        error: `file not found: ${req.path} (${err instanceof Error ? err.message : String(err)})`
      };
    }
    if (!fileStat.isFile()) {
      return { ok: false, status: 400, error: `not a regular file: ${req.path}` };
    }
    if (fileStat.size > TELEGRAM_DOCUMENT_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `file too large: ${fileStat.size} bytes (Telegram document cap is ${TELEGRAM_DOCUMENT_MAX_BYTES})`
      };
    }
    if (fileStat.size === 0) {
      // Telegram rejects empty documents with a vague error — pre-empt it.
      return { ok: false, status: 400, error: `file is empty: ${req.path}` };
    }

    const users = this.deps.sessionManager.findUsersForWindow(req.windowId);
    if (users.length === 0) {
      return {
        ok: false,
        status: 404,
        error: `no Telegram topic is bound to window ${req.windowId}`
      };
    }

    const buffer = await readFile(req.path);
    const filename = basename(req.path);
    const mediaType = mimeFromPath(req.path);
    const caption = (req.caption ?? defaultCaption(filename, buffer.length)).slice(0, 1024);

    // Fan out per (user, thread). Each delivery runs as an independent
    // enqueue + drain so one failing chat doesn't block another. We AWAIT
    // all drains here (vs fire-and-forget) so the HTTP response reflects
    // real delivery — the CLI's "sent foo.zip" message must not lie when
    // TG is down or 429-exhausted.
    const outcomes = await Promise.allSettled(
      users.map(async ([userId, windowId, threadId]) => {
        this.deps.messageQueue.enqueueContentMessage(userId, windowId, [caption], {
          // contentType=tool_result + parts.length<=1 + imageData triggers the
          // single-captioned-document path in MessageQueueManager.processContentTask.
          contentType: "tool_result",
          role: "assistant",
          threadId,
          imageData: [{ mediaType, data: buffer, filename }]
        });
        await this.deps.messageQueue.drain(userId);
      })
    );

    const failed: Array<{ userId: number; threadId: number; reason: unknown }> = [];
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") {
        const [userId, , threadId] = users[i]!;
        failed.push({ userId, threadId, reason: o.reason });
      }
    });
    if (failed.length > 0) {
      logger().warn(
        { filename, sizeBytes: fileStat.size, totalUsers: users.length, failed },
        "outbound sendFile: some drains rejected"
      );
    }

    const deliveries = users.length - failed.length;
    if (deliveries === 0) {
      return {
        ok: false,
        status: 502,
        error: `all ${users.length} delivery attempt(s) failed (see logs for details)`,
        deliveries: 0,
        failed: failed.length,
        sizeBytes: fileStat.size,
        filename
      };
    }
    return {
      ok: true,
      status: 200,
      deliveries,
      failed: failed.length,
      sizeBytes: fileStat.size,
      filename
    };
  }
}

export function mimeFromPath(p: string): string {
  const ext = extname(p).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function defaultCaption(filename: string, sizeBytes: number): string {
  return `📎 ${filename} (${prettySize(sizeBytes)})`;
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Global per-tmux-session registry. Populated by multiBotRuntime when a bot
// starts; depopulated when it stops. Mirrors hookRouterRegistry so the
// /bot/send-file endpoint can find the right per-bot dispatcher without
// having to plumb through MultiBotRuntimeManager.
export const outboundRegistry = new Map<string, OutboundDispatcher>();
