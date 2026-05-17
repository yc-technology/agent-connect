import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { writeFakeTranscript } from "./helpers/transcriptFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

describe("regression: first response race", () => {
  test("fast assistant reply written before any polling tick is delivered", async () => {
    const registry = new SessionRegistry(inMemoryDb());
    const dispatched: Array<{ text: string; role: string; contentType: string }> = [];
    const router = new HookRouter({
      registry,
      dispatcher: async (_w, entries) => {
        for (const e of entries) {
          dispatched.push({ text: e.text, role: e.role, contentType: e.contentType });
        }
      },
      agentType: "claude"
    });

    // Simulate fast Claude: transcript already contains user prompt + complete reply
    // before any hook arrives.
    const path = await writeFakeTranscript([
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } }
    ]);

    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "X", transcript_path: path, cwd: "/a", source: "startup" },
        { window_id: "@0" }
      )
    );
    await router.dispatch(
      envelope(
        "Stop",
        { session_id: "X", transcript_path: path, cwd: "/a" },
        { window_id: "@0" }
      )
    );

    expect(dispatched).toContainEqual({ text: "Hi!", role: "assistant", contentType: "text" });
  });
});
