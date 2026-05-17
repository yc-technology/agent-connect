import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

function setup(): SessionRegistry {
  const reg = new SessionRegistry(inMemoryDb());
  reg.upsertWindow("@0", "x", "/a");
  reg.upsertWindow("@1", "y", "/b");
  reg.registerSession({ sessionId: "S1", windowId: "@0", agentType: "claude", transcriptPath: "/p1", cwd: "/a" });
  reg.registerSession({ sessionId: "S2", windowId: "@1", agentType: "claude", transcriptPath: "/p2", cwd: "/b" });
  return reg;
}

describe("SessionRegistry withSessionLock", () => {
  test("serializes same-session callers (no overlap)", async () => {
    const reg = setup();
    const events: string[] = [];
    const ops = [
      reg.withSessionLock("S1", async () => {
        events.push("A-in");
        await sleep(40);
        events.push("A-out");
      }),
      reg.withSessionLock("S1", async () => {
        events.push("B-in");
        await sleep(10);
        events.push("B-out");
      })
    ];
    await Promise.all(ops);
    expect(events).toEqual(["A-in", "A-out", "B-in", "B-out"]);
  });

  test("different sessions run in parallel", async () => {
    const reg = setup();
    const start = Date.now();
    await Promise.all([
      reg.withSessionLock("S1", async () => sleep(50)),
      reg.withSessionLock("S2", async () => sleep(50))
    ]);
    expect(Date.now() - start).toBeLessThan(90);
  });

  test("lock released when callback throws", async () => {
    const reg = setup();
    await expect(
      reg.withSessionLock("S1", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const ok = await reg.withSessionLock("S1", async () => "still works");
    expect(ok).toBe("still works");
  });

  test("callback receives current SessionRow", async () => {
    const reg = setup();
    const seen = await reg.withSessionLock("S1", async (s) => s.transcript_path);
    expect(seen).toBe("/p1");
  });

  test("unknown session id throws without leaking lock", async () => {
    const reg = setup();
    await expect(reg.withSessionLock("UNKNOWN", async () => 1)).rejects.toThrow();
    const ok = await reg.withSessionLock("S1", async () => "ok");
    expect(ok).toBe("ok");
  });

  test("setOffset inside lock is visible to next caller", async () => {
    const reg = setup();
    await reg.withSessionLock("S1", async () => {
      reg.setOffset("S1", 1234);
    });
    const next = await reg.withSessionLock("S1", async (s) => s.last_byte_offset);
    expect(next).toBe(1234);
  });
});
