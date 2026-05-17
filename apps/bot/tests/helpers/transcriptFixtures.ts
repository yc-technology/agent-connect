// apps/bot/tests/helpers/transcriptFixtures.ts
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TranscriptEntry {
  type: "user" | "assistant" | string;
  [key: string]: unknown;
}

let tmpRoot: string | null = null;
async function ensureTmpRoot(): Promise<string> {
  if (!tmpRoot) tmpRoot = await mkdtemp(join(tmpdir(), "agc-test-"));
  return tmpRoot;
}

export async function writeFakeTranscript(
  entries: TranscriptEntry[],
  opts: { sessionId?: string } = {}
): Promise<string> {
  const root = await ensureTmpRoot();
  const name = `${opts.sessionId ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`}.jsonl`;
  const path = join(root, name);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  await writeFile(path, content, "utf8");
  return path;
}

export async function appendToTranscript(
  path: string,
  entries: TranscriptEntry[]
): Promise<void> {
  if (!entries.length) return;
  await appendFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
