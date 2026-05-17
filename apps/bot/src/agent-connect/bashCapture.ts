import { editWithFallback, sendWithFallback, type TelegramApiLike } from "./messageSender.js";
import type { SessionRoutingLike } from "./messageQueue.js";
import { extractBashOutput } from "./terminalParser.js";
import { threadOptions } from "./telegramThread.js";
import type { TmuxManager } from "./tmuxManager.js";

export interface BashCaptureDeps {
  api: TelegramApiLike;
  routing: SessionRoutingLike;
  tmuxManager: Pick<TmuxManager, "capturePane">;
}

export interface BashCaptureTaskOptions {
  initialDelayMs?: number;
  pollDelayMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface BashCaptureTask {
  userId: number;
  threadId: number;
  windowId: string;
  command: string;
}

type CaptureKey = `${number}:${number}`;

export class BashCaptureManager {
  private readonly controllers = new Map<CaptureKey, AbortController>();

  constructor(
    private readonly deps: BashCaptureDeps,
    private readonly options: Omit<BashCaptureTaskOptions, "signal"> = {}
  ) {}

  start(userId: number, threadId: number, windowId: string, command: string): void {
    this.cancel(userId, threadId);
    const controller = new AbortController();
    const key = captureKey(userId, threadId);
    this.controllers.set(key, controller);

    void runBashCaptureTask(
      this.deps,
      { userId, threadId, windowId, command },
      { ...this.options, signal: controller.signal }
    )
      .catch(() => undefined)
      .finally(() => {
        if (this.controllers.get(key) === controller) {
          this.controllers.delete(key);
        }
      });
  }

  cancel(userId: number, threadId: number): void {
    const key = captureKey(userId, threadId);
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

export async function runBashCaptureTask(
  deps: BashCaptureDeps,
  task: BashCaptureTask,
  options: BashCaptureTaskOptions = {}
): Promise<void> {
  const initialDelayMs = options.initialDelayMs ?? 2000;
  const pollDelayMs = options.pollDelayMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 30;
  const signal = options.signal;

  await sleep(initialDelayMs, signal);
  if (signal?.aborted) return;

  const chatId = deps.routing.resolveChatId(task.userId, task.threadId);
  let messageId: number | null = null;
  let lastOutput = "";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) return;

    const paneText = await deps.tmuxManager.capturePane(task.windowId);
    if (!paneText) return;

    const output = extractBashOutput(paneText, task.command);
    if (!output) {
      await sleep(pollDelayMs, signal);
      continue;
    }

    if (output === lastOutput) {
      await sleep(pollDelayMs, signal);
      continue;
    }

    lastOutput = output;
    const text = output.length > 3800 ? `... ${output.slice(-3800)}` : output;
    const options = threadOptions(task.threadId);

    if (messageId === null) {
      const sent = await sendWithFallback(deps.api, chatId, text, options);
      if (sent) messageId = sent.message_id;
    } else {
      await editWithFallback(deps.api, chatId, messageId, text, options);
    }

    await sleep(pollDelayMs, signal);
  }
}

function captureKey(userId: number, threadId: number): CaptureKey {
  return `${userId}:${threadId}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
