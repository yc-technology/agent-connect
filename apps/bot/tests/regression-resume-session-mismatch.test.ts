import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { writeFakeTranscript, appendToTranscript } from "./helpers/transcriptFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

describe("regression: resume session id mismatch", () => {
  test("hook reports a different session_id than the transcript filename — bot follows transcript_path", async () => {
    const registry = new SessionRegistry(inMemoryDb());
    const dispatched: string[] = [];
    const router = new HookRouter({
      registry,
      dispatcher: async (_w, entries) => {
        for (const e of entries) dispatched.push(e.text);
      },
      agentType: "claude"
    });

    // The file is named after the *original* session id "X", but the hook reports a NEW id "Y".
    const transcriptX = await writeFakeTranscript(
      [{ type: "assistant", message: { content: [{ type: "text", text: "prior turn" }] } }],
      { sessionId: "X" }
    );

    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "Y", transcript_path: transcriptX, cwd: "/a", source: "resume" },
        { window_id: "@0" }
      )
    );

    // Claude continues writing to X.jsonl after resume.
    await appendToTranscript(transcriptX, [
      { type: "user", message: { content: "hi again" } },
      { type: "assistant", message: { content: [{ type: "text", text: "resumed reply" }] } }
    ]);

    await router.dispatch(
      envelope(
        "Stop",
        { session_id: "Y", transcript_path: transcriptX, cwd: "/a" },
        { window_id: "@0" }
      )
    );

    expect(dispatched).toContain("resumed reply");
    const row = registry.getSessionByWindow("@0")!;
    expect(row.session_id).toBe("Y");
    expect(row.transcript_path).toBe(transcriptX);
  });
});
