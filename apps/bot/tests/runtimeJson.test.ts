import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  writeRuntimeJson,
  readRuntimeJson,
  removeRuntimeJson,
  tcpProbe
} from "../src/agent-connect/runtimeJson.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runtime-json-test-"));
});

describe("runtimeJson", () => {
  test("write then read", async () => {
    await writeRuntimeJson(dir, { httpHost: "127.0.0.1", httpPort: 8787, pid: 99 });
    const got = await readRuntimeJson(dir);
    expect(got).toEqual({ httpHost: "127.0.0.1", httpPort: 8787, pid: 99 });
  });

  test("read returns null when absent", async () => {
    expect(await readRuntimeJson(dir)).toBeNull();
  });

  test("remove is idempotent", async () => {
    await removeRuntimeJson(dir);
    await writeRuntimeJson(dir, { httpHost: "127.0.0.1", httpPort: 1, pid: 1 });
    await removeRuntimeJson(dir);
    await removeRuntimeJson(dir);
    expect(await readRuntimeJson(dir)).toBeNull();
  });
});

describe("tcpProbe", () => {
  test("returns true when port is listening", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    expect(await tcpProbe("127.0.0.1", port, 500)).toBe(true);
    server.close();
  });

  test("returns false when nothing is listening", async () => {
    expect(await tcpProbe("127.0.0.1", 1, 200)).toBe(false);
  });
});
