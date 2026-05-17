import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";

export interface RuntimeInfo {
  httpHost: string;
  httpPort: number;
  pid: number;
}

function runtimePath(dir: string): string {
  return join(dir, "runtime.json");
}

export async function writeRuntimeJson(dir: string, info: RuntimeInfo): Promise<void> {
  await writeFile(runtimePath(dir), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export async function readRuntimeJson(dir: string): Promise<RuntimeInfo | null> {
  const path = runtimePath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeInfo>;
    if (
      typeof parsed.httpHost !== "string" ||
      typeof parsed.httpPort !== "number" ||
      typeof parsed.pid !== "number"
    ) {
      return null;
    }
    return { httpHost: parsed.httpHost, httpPort: parsed.httpPort, pid: parsed.pid };
  } catch {
    return null;
  }
}

export async function removeRuntimeJson(dir: string): Promise<void> {
  await rm(runtimePath(dir), { force: true });
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
