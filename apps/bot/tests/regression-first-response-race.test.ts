import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { HookRouter } from "../src/agent-connect/hookRouter.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";
import { appendToTranscript, writeFakeTranscript } from "./helpers/transcriptFixtures.js";
import { envelope } from "./helpers/hookEnvelope.js";

describe("regression: first response race", () => {
  test("fast assistant reply written between SessionStart and Stop is delivered", async () => {
    // Real-world shape: Claude fires SessionStart on a fresh transcript, then
    // writes the first turn's user prompt + reply, then fires Stop in quick
    // succession. The drain chain must deliver the assistant text — the
    // earlier bug was a missed dispatch when the polling tick lost the race
    // against Stop. (After the universal-EOF SessionStart seeding, a fully
    // pre-populated transcript would intentionally NOT be re-emitted, so this
    // test models the actual hook order Claude produces.)
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

    const path = await writeFakeTranscript([]);

    await router.dispatch(
      envelope(
        "SessionStart",
        { session_id: "X", transcript_path: path, cwd: "/a", source: "startup" },
        { window_id: "@0" }
      )
    );
    await appendToTranscript(path, [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } }
    ]);
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
