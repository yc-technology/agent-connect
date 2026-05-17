import { describe, test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { drainTranscript, type Dispatcher } from "../src/agent-connect/drainTranscript.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { writeFakeTranscript, appendToTranscript } from "./helpers/transcriptFixtures.js";

interface DispatchCall {
  windowId: string;
  count: number;
  texts: string[];
}

function setup(): { reg: SessionRegistry; calls: DispatchCall[]; dispatcher: Dispatcher } {
  const reg = new SessionRegistry(inMemoryDb());
  reg.upsertWindow("@0", "x", "/a");
  const calls: DispatchCall[] = [];
  const dispatcher: Dispatcher = async (windowId, entries) => {
    calls.push({
      windowId,
      count: entries.length,
      texts: entries.map((e) => e.text)
    });
  };
  return { reg, calls, dispatcher };
}

describe("drainTranscript", () => {
  test("no-op when transcript_path is empty", async () => {
    const { reg, calls, dispatcher } = setup();
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: "", cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toEqual([]);
  });

  test("no-op when file does not exist", async () => {
    const { reg, calls, dispatcher } = setup();
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: "/no/such/file.jsonl", cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toEqual([]);
  });

  test("reads new entries and advances offset", async () => {
    const { reg, calls, dispatcher } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "hello world" }] } }
    ]);
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: path, cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ windowId: "@0", count: 1, texts: ["hello world"] });
    const offsetAfter = reg.getSession("S")!.last_byte_offset;
    expect(offsetAfter).toBeGreaterThan(0);
  });

  test("second call delivers only new content", async () => {
    const { reg, calls, dispatcher } = setup();
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } }
    ]);
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: path, cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    await appendToTranscript(path, [
      { type: "assistant", message: { content: [{ type: "text", text: "second" }] } }
    ]);
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.texts).toEqual(["second"]);
  });

  test("file truncation (size shrinks) resets offset and re-reads", async () => {
    const { reg, calls, dispatcher } = setup();
    // Seed with a long entry so the next write is unambiguously smaller.
    const longText = "x".repeat(200);
    const path = await writeFakeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: longText }] } }
    ]);
    reg.registerSession({ sessionId: "S", windowId: "@0", agentType: "claude", transcriptPath: path, cwd: "/a" });
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(1);
    // Replace with shorter content. size < offset triggers truncation handling.
    await writeFile(
      path,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }) + "\n",
      "utf8"
    );
    await drainTranscript(reg, dispatcher, "S");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.texts).toEqual(["x"]);
  });

  test("skips unknown session id", async () => {
    const { reg, calls, dispatcher } = setup();
    await drainTranscript(reg, dispatcher, "UNKNOWN");
    expect(calls).toEqual([]);
  });
});
