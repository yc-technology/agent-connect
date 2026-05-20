import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundDispatcher, mimeFromPath } from "../src/agent-connect/outboundDispatcher.js";
import { installCaptureLogger } from "./helpers/testLogger.js";

function fakeDeps() {
  return {
    sessionManager: {
      findUsersForWindow: vi.fn(
        (windowId: string): Array<[number, string, number]> => {
          if (windowId === "@1") return [[100, "@1", 42]];
          if (windowId === "@multi") {
            return [
              [100, "@multi", 42],
              [200, "@multi", 43]
            ];
          }
          return [];
        }
      )
    },
    messageQueue: {
      enqueueContentMessage: vi.fn(),
      drain: vi.fn(async () => undefined)
    }
  };
}

let tempDir: string;
let dispatcher: OutboundDispatcher;
let deps: ReturnType<typeof fakeDeps>;

beforeEach(async () => {
  installCaptureLogger();
  tempDir = await mkdtemp(join(tmpdir(), "agc-outbound-test-"));
  deps = fakeDeps();
  dispatcher = new OutboundDispatcher(deps);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("OutboundDispatcher.sendFile", () => {
  it("enqueues a captioned tool_result image-task with the actual filename", async () => {
    const filePath = join(tempDir, "build.zip");
    const payload = Buffer.from("PK\x03\x04 fake zip bytes");
    await writeFile(filePath, payload);

    const result = await dispatcher.sendFile({ windowId: "@1", path: filePath });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.deliveries).toBe(1);
    expect(result.filename).toBe("build.zip");
    expect(result.sizeBytes).toBe(payload.length);

    expect(deps.messageQueue.enqueueContentMessage).toHaveBeenCalledTimes(1);
    const [userId, windowId, parts, options] = deps.messageQueue.enqueueContentMessage.mock
      .calls[0]!;
    expect(userId).toBe(100);
    expect(windowId).toBe("@1");
    expect(parts).toEqual([expect.stringContaining("📎 build.zip")]);
    expect(options).toMatchObject({
      contentType: "tool_result",
      role: "assistant",
      threadId: 42,
      imageData: [
        {
          mediaType: "application/zip",
          filename: "build.zip"
        }
      ]
    });
    expect(options.imageData![0].data).toEqual(payload);
    expect(deps.messageQueue.drain).toHaveBeenCalledWith(100);
  });

  it("fans out one enqueue per bound user when multiple topics share a window", async () => {
    const filePath = join(tempDir, "log.txt");
    await writeFile(filePath, "hello");

    const result = await dispatcher.sendFile({ windowId: "@multi", path: filePath });

    expect(result.ok).toBe(true);
    expect(result.deliveries).toBe(2);
    expect(deps.messageQueue.enqueueContentMessage).toHaveBeenCalledTimes(2);
    expect(deps.messageQueue.enqueueContentMessage.mock.calls[0]![0]).toBe(100);
    expect(deps.messageQueue.enqueueContentMessage.mock.calls[1]![0]).toBe(200);
  });

  it("honors a caller-supplied caption (truncated to 1024 chars)", async () => {
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "x");
    const big = "x".repeat(2000);

    const result = await dispatcher.sendFile({ windowId: "@1", path: filePath, caption: big });

    expect(result.ok).toBe(true);
    const parts = deps.messageQueue.enqueueContentMessage.mock.calls[0]![2]!;
    expect(parts[0]!.length).toBe(1024);
  });

  it("returns 404 when no topic is bound to the window", async () => {
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "x");

    const result = await dispatcher.sendFile({ windowId: "@unknown", path: filePath });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("no Telegram topic");
    expect(deps.messageQueue.enqueueContentMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when the file does not exist", async () => {
    const result = await dispatcher.sendFile({
      windowId: "@1",
      path: join(tempDir, "does-not-exist")
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(deps.messageQueue.enqueueContentMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when the path points at a directory", async () => {
    const result = await dispatcher.sendFile({ windowId: "@1", path: tempDir });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("not a regular file");
  });

  it("returns 400 for an empty file (TG rejects 0-byte documents)", async () => {
    const filePath = join(tempDir, "empty.bin");
    await writeFile(filePath, "");
    const result = await dispatcher.sendFile({ windowId: "@1", path: filePath });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("empty");
  });

  it("awaits all drains and reports partial failure without lying about success", async () => {
    // Single user: drain rejects → all deliveries failed → ok=false 502.
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "x");
    deps.messageQueue.drain.mockRejectedValueOnce(new Error("simulated TG outage"));

    const result = await dispatcher.sendFile({ windowId: "@1", path: filePath });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.deliveries).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.error).toMatch(/all 1 delivery/);
  });

  it("reports partial success when one of N users drain fails", async () => {
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "x");
    // First call fails (user 100), second succeeds (user 200).
    deps.messageQueue.drain
      .mockRejectedValueOnce(new Error("simulated"))
      .mockResolvedValueOnce(undefined);

    const result = await dispatcher.sendFile({ windowId: "@multi", path: filePath });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.deliveries).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("rejects path/windowId of the wrong type up front", async () => {
    const r1 = await dispatcher.sendFile({
      windowId: "@1",
      path: ""
    });
    expect(r1.status).toBe(400);
    const r2 = await dispatcher.sendFile({
      windowId: "",
      path: "/tmp/x"
    });
    expect(r2.status).toBe(400);
  });
});

describe("mimeFromPath", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(mimeFromPath("/tmp/build.zip")).toBe("application/zip");
    expect(mimeFromPath("/tmp/notes.MD")).toBe("text/markdown");
    expect(mimeFromPath("/tmp/screenshot.PNG")).toBe("image/png");
    expect(mimeFromPath("/tmp/no-extension")).toBe("application/octet-stream");
    expect(mimeFromPath("/tmp/foo.unknownext")).toBe("application/octet-stream");
  });
});
