import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPidAlive,
  readSupervisorJson,
  removeSupervisorJson,
  writeSupervisorJson,
  type SupervisorInfo
} from "../src/agent-connect/supervisorJson.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agc-supervisor-json-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(over: Partial<SupervisorInfo> = {}): SupervisorInfo {
  return {
    supervisorPid: 1234,
    serverPid: 5678,
    httpHost: "127.0.0.1",
    httpPort: 17666,
    startedAt: "2026-05-19T10:00:00.000Z",
    restartCount: 2,
    lastRestartReason: "healthz failed 3 times",
    lastRestartAt: "2026-05-19T11:00:00.000Z",
    lastHealthCheckAt: "2026-05-19T12:00:00.000Z",
    lastHealthCheckOk: true,
    ...over
  };
}

describe("supervisorJson", () => {
  it("writes and reads back the full SupervisorInfo shape", async () => {
    const info = sample();
    await writeSupervisorJson(dir, info);
    const got = await readSupervisorJson(dir);
    expect(got).toEqual(info);
  });

  it("returns null when supervisor.json is missing", async () => {
    expect(await readSupervisorJson(dir)).toBeNull();
  });

  it("returns null on a malformed file rather than throwing", async () => {
    writeFileSync(join(dir, "supervisor.json"), "not valid json {", "utf8");
    expect(await readSupervisorJson(dir)).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    writeFileSync(
      join(dir, "supervisor.json"),
      JSON.stringify({ supervisorPid: 1 }), // missing httpHost/httpPort/startedAt
      "utf8"
    );
    expect(await readSupervisorJson(dir)).toBeNull();
  });

  it("defaults optional fields when they are absent in the on-disk file", async () => {
    writeFileSync(
      join(dir, "supervisor.json"),
      JSON.stringify({
        supervisorPid: 9,
        httpHost: "127.0.0.1",
        httpPort: 17666,
        startedAt: "2026-05-19T00:00:00.000Z"
        // serverPid, restartCount, lastRestart*, lastHealth* all omitted
      }),
      "utf8"
    );
    const got = await readSupervisorJson(dir);
    expect(got).toMatchObject({
      supervisorPid: 9,
      serverPid: null,
      restartCount: 0,
      lastRestartReason: null,
      lastRestartAt: null,
      lastHealthCheckAt: null,
      lastHealthCheckOk: null
    });
  });

  it("removeSupervisorJson deletes the file when present and no-ops otherwise", async () => {
    await writeSupervisorJson(dir, sample());
    await removeSupervisorJson(dir);
    expect(await readSupervisorJson(dir)).toBeNull();
    // Idempotent — calling again on the missing file shouldn't throw.
    await removeSupervisorJson(dir);
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously-impossible pid", () => {
    // 2^31 - 1 — well above any realistic OS pid.
    expect(isPidAlive(2_147_483_640)).toBe(false);
  });
});
