import { execFile } from "node:child_process";
import { request } from "node:http";
import { promisify } from "node:util";
import type { Readable, Writable } from "node:stream";
import { agentConnectDir } from "./utils.js";
import { readRuntimeJson } from "./runtimeJson.js";

const execFileAsync = promisify(execFile);

interface TmuxInfo {
  tmuxSession: string;
  windowId: string;
  windowName: string;
}

async function readStdin(stdin: Readable): Promise<string> {
  let buf = "";
  for await (const chunk of stdin) buf += chunk;
  return buf;
}

async function tmuxInfo(env: NodeJS.ProcessEnv): Promise<TmuxInfo | null> {
  const pane = env.TMUX_PANE;
  if (!pane) return null;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-t", pane, "-p", "#{session_name}:#{window_id}:#{window_name}"],
      { encoding: "utf8" }
    );
    const trimmed = stdout.trim();
    const first = trimmed.indexOf(":");
    const second = first >= 0 ? trimmed.indexOf(":", first + 1) : -1;
    if (first < 0 || second < 0) return null;
    return {
      tmuxSession: trimmed.slice(0, first),
      windowId: trimmed.slice(first + 1, second),
      windowName: trimmed.slice(second + 1)
    };
  } catch {
    return null;
  }
}

function postEnvelope(
  host: string,
  port: number,
  body: string,
  timeoutMs = 2000
): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      {
        host,
        port,
        method: "POST",
        path: "/hook/events",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        },
        timeout: timeoutMs
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      }
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

export async function runHookClient(
  stdin: Readable = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
  _stdout: Writable = process.stdout,
  _stderr: Writable = process.stderr
): Promise<number> {
  const raw = (await readStdin(stdin)).trim();
  if (!raw) return 0;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const info = await tmuxInfo(env);
  if (!info) return 0;
  const runtime = await readRuntimeJson(agentConnectDir(env));
  if (!runtime) return 0;
  const envelope = {
    tmux_session: info.tmuxSession,
    window_id: info.windowId,
    window_name: info.windowName,
    payload
  };
  await postEnvelope(runtime.httpHost, runtime.httpPort, JSON.stringify(envelope));
  return 0;
}
