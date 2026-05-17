import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const AGENT_CONNECT_DIR_ENV = "AGENT_CONNECT_DIR";

export function agentConnectDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[AGENT_CONNECT_DIR_ENV];
  return raw && raw.length > 0 ? raw : join(homedir(), ".agent-connect");
}

export async function atomicWriteJson(
  path: string,
  data: unknown,
  indent = 2
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(data, null, indent)}\n`;

  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

export async function readCwdFromJsonl(filePath: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return "";
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const data = JSON.parse(line) as { cwd?: unknown };
      if (typeof data.cwd === "string" && data.cwd.length > 0) {
        return data.cwd;
      }
    } catch {
      continue;
    }
  }
  return "";
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}
