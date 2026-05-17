import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteJson, agentConnectDir, readCwdFromJsonl } from "../src/agent-connect/utils.js";

describe("agentConnectDir", () => {
  it("uses AGENT_CONNECT_DIR when provided", () => {
    expect(agentConnectDir({ AGENT_CONNECT_DIR: "/custom/config" })).toBe("/custom/config");
  });
});

describe("atomicWriteJson", () => {
  it("writes JSON and creates parent directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-utils-test-"));
    try {
      const target = join(dir, "a", "b", "data.json");
      await atomicWriteJson(target, { ok: true });
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readCwdFromJsonl", () => {
  it("returns the first cwd field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-connect-jsonl-test-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({ type: "init" })}\n${JSON.stringify({ cwd: "/found/here" })}\n`
      );
      expect(await readCwdFromJsonl(file)).toBe("/found/here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty string for missing files", async () => {
    expect(await readCwdFromJsonl("/path/that/does/not/exist.jsonl")).toBe("");
  });
});
