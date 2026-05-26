import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSupervisor } from "../src/agent-connect/supervisor.js";
import { readSupervisorJson } from "../src/agent-connect/supervisorJson.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agc-supervisor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Minimal ChildProcess stub. Tests fire `emit("exit", code, signal)`
 * explicitly whenever the supervisor's kill flow is about to wait on a
 * real SIGTERM that wouldn't actually arrive (the pid is fake, so
 * tree-kill is a no-op).
 */
function fakeChild(pid = 12345): EventEmitter & { pid: number; exitCode: number | null } {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
  };
  ee.pid = pid;
  ee.exitCode = null;
  return ee;
}

/**
 * Shut the supervisor down without hanging on the fake child's
 * non-arriving SIGTERM response: emit "exit" on every passed-in child a
 * few ms after issuing shutdown so killChildGracefully's once-listener
 * resolves.
 */
async function shutdownEmitting(
  sv: { shutdown(reason: string): Promise<void> },
  children: EventEmitter[]
): Promise<void> {
  const p = sv.shutdown("test teardown");
  setTimeout(() => {
    for (const c of children) c.emit("exit", 0, "SIGTERM");
  }, 5);
  await p;
}

function baseOpts(extras: Partial<Parameters<typeof buildSupervisor>[0]> = {}) {
  return {
    nodeExecutable: "/usr/bin/node",
    cliScript: "/fake/agc",
    serverArgs: ["start"],
    httpHost: "127.0.0.1",
    httpPort: 17666,
    configDir: dir,
    // Compress all timing for tests.
    healthCheckIntervalMs: 50,
    healthCheckTimeoutMs: 50,
    healthCheckFailureThreshold: 2,
    backoffMs: [10, 20, 30],
    bootHealthyTimeoutMs: 1_000,
    sleepFn: () => Promise.resolve(),
    ...extras
  };
}

describe("supervisor", () => {
  it("boots: spawns child, waits for healthy, writes supervisor.json", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child as never);
    const probeHealthFn = vi.fn(async () => true);
    const sv = buildSupervisor(baseOpts({ spawnFn, probeHealthFn }));
    await sv.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(sv.state()).toBe("healthy");

    const info = await readSupervisorJson(dir);
    expect(info).toMatchObject({
      supervisorPid: process.pid,
      serverPid: 12345,
      httpHost: "127.0.0.1",
      httpPort: 17666,
      restartCount: 0
    });
    await shutdownEmitting(sv, [child]);
  });

  it("restart() flips state through restarting → starting → healthy + bumps restartCount", async () => {
    const c1 = fakeChild(1000);
    const c2 = fakeChild(1001);
    let nthSpawn = 0;
    const spawnFn = vi.fn(() => (nthSpawn++ === 0 ? c1 : c2) as never);
    const probeHealthFn = vi.fn(async () => true);
    const sv = buildSupervisor(baseOpts({ spawnFn, probeHealthFn }));
    await sv.start();
    expect(sv.restartCount()).toBe(0);

    const p = sv.restart("manual test");
    // The kill flow waits on the child's `exit` event — fire it.
    setTimeout(() => c1.emit("exit", 0, "SIGTERM"), 5);
    await p;

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(sv.state()).toBe("healthy");
    expect(sv.restartCount()).toBe(1);

    const info = await readSupervisorJson(dir);
    expect(info?.restartCount).toBe(1);
    expect(info?.lastRestartReason).toBe("manual test");
    await shutdownEmitting(sv, [c2]);
  });

  it("concurrent restart() calls coalesce into a single in-flight restart", async () => {
    const children = [fakeChild(10), fakeChild(11)];
    let i = 0;
    const spawnFn = vi.fn(() => children[i++] as never);
    const probeHealthFn = vi.fn(async () => true);
    const sv = buildSupervisor(baseOpts({ spawnFn, probeHealthFn }));
    await sv.start();

    // Fire three concurrent restarts before the first one has a chance
    // to complete its kill+spawn cycle.
    const r1 = sv.restart("first");
    const r2 = sv.restart("second");
    const r3 = sv.restart("third");
    // Fire the first child's exit so the first restart can proceed.
    setTimeout(() => children[0]!.emit("exit", 0, "SIGTERM"), 5);
    await Promise.all([r1, r2, r3]);

    // Only one actual respawn — the other two coalesced into the same
    // in-flight promise.
    expect(spawnFn).toHaveBeenCalledTimes(2); // initial + 1 restart
    expect(sv.restartCount()).toBe(1);
    await shutdownEmitting(sv, [children[1]!]);
  });

  it("shutdown removes supervisor.json and rejects further restarts", async () => {
    const child = fakeChild();
    const sv = buildSupervisor(
      baseOpts({
        spawnFn: vi.fn(() => child as never),
        probeHealthFn: vi.fn(async () => true)
      })
    );
    await sv.start();
    expect(await readSupervisorJson(dir)).not.toBeNull();

    await shutdownEmitting(sv, [child]);
    expect(sv.state()).toBe("stopping");
    expect(await readSupervisorJson(dir)).toBeNull();

    // A restart call after shutdown is a no-op (returns immediately).
    await sv.restart("late attempt");
    expect(sv.restartCount()).toBe(0);
  });

  it("healthz failures past the threshold trigger a restart", async () => {
    const c1 = fakeChild(100);
    const c2 = fakeChild(101);
    let nth = 0;
    const spawnFn = vi.fn(() => (nth++ === 0 ? c1 : c2) as never);
    // Pattern: true (initial boot) → false (tick 1) → false (tick 2; threshold) → true (post-restart probe loop)
    let call = 0;
    const probeHealthFn = vi.fn(async () => {
      call += 1;
      if (call === 1) return true; // initial boot
      if (call === 2 || call === 3) return false; // threshold of 2 failures
      return true; // post-restart boot probe
    });
    const sv = buildSupervisor(
      baseOpts({ spawnFn, probeHealthFn, healthCheckFailureThreshold: 2 })
    );
    await sv.start();

    // Fire c1's exit when the auto-restart's kill phase asks for it. Use a
    // setTimeout (not micro-tick) so it lines up with the supervisor's
    // healthTick → restartServer → killChildGracefully timing.
    setTimeout(() => c1.emit("exit", 0, "SIGTERM"), 130);

    // Poll for the persisted restart reason instead of a fixed sleep:
    //   - `restartCount` flips to ≥1 the instant doRestart() starts
    //     (in-memory increment before any await).
    //   - `supervisor.json.lastRestartReason` only appears after
    //     `await persist()` flushes — which on slow CI Linux can lag
    //     200ms+ past restartCount turning over. The previous fixed
    //     250ms wait was enough on local macOS but raced on CI.
    let info: Awaited<ReturnType<typeof readSupervisorJson>> = null;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (sv.restartCount() >= 1) {
        info = await readSupervisorJson(dir);
        if (info?.lastRestartReason?.includes("healthz failed")) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(sv.restartCount()).toBeGreaterThanOrEqual(1);
    expect(info?.lastRestartReason).toContain("healthz failed");
    await shutdownEmitting(sv, [c2]);
  });

  it("child exit code 2 → no respawn, supervisor stops", async () => {
    // Code 2 is service.ts's "explicit bail, don't respawn me" signal,
    // emitted when a fresh child detects another agent-connect already
    // listening on its port. Respawning would just hit the same conflict
    // forever — that's what produced the 8786-cycle loop reported in the
    // wild on upgrade-without-stop.
    const c1 = fakeChild(1);
    const spawnFn = vi.fn(() => c1 as never);
    const probeHealthFn = vi.fn(async () => true);
    const sv = buildSupervisor(baseOpts({ spawnFn, probeHealthFn }));
    const startP = sv.start();

    // Wait for first spawn to register.
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Child bails with code 2.
    c1.emit("exit", 2, null);

    // Give the supervisor a beat — confirm no respawn happens.
    await new Promise((r) => setTimeout(r, 200));
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // supervisor.start() resolved (no longer hung waiting for shutdown).
    await startP;
  });

  it("crash-loop backstop trips after restartBudget exits within window", async () => {
    // Same scenario as code 2 but the child exits with code 1 (or any
    // other non-2 code) — e.g. legacy supervisor predating the fix, or
    // a real startup bug. The supervisor should give up after the budget
    // is exhausted rather than looping for hours.
    const children: ReturnType<typeof fakeChild>[] = [];
    let nth = 0;
    const spawnFn = vi.fn(() => {
      const c = fakeChild(nth + 1);
      children.push(c);
      nth += 1;
      return c as never;
    });
    const probeHealthFn = vi.fn(async () => true);
    const sv = buildSupervisor(
      baseOpts({
        spawnFn,
        probeHealthFn,
        restartBudget: 2, // bail after 2 unintentional exits in window
        restartBudgetWindowMs: 10_000
      })
    );
    const startP = sv.start();

    // Wait first spawn.
    await new Promise((r) => setTimeout(r, 30));

    // Three crashes in quick succession — should exceed budget of 2.
    children[0]!.emit("exit", 1, null);
    await new Promise((r) => setTimeout(r, 30));
    children[1]?.emit("exit", 1, null);
    await new Promise((r) => setTimeout(r, 30));
    children[2]?.emit("exit", 1, null);
    await new Promise((r) => setTimeout(r, 100));

    // Initial spawn + 2 respawns inside the budget = 3 spawns total.
    // The 3rd crash trips the backstop, so spawn 4 never happens.
    expect(spawnFn.mock.calls.length).toBeLessThanOrEqual(3);
    await startP;
  });
});
