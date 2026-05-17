import type { Config } from "./config.js";

export class EmptyTranscriptionError extends Error {
  constructor() {
    super("Empty transcription returned by API");
    this.name = "EmptyTranscriptionError";
  }
}

export class TranscriptionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Transcription API request failed with status ${status}`);
    this.name = "TranscriptionHttpError";
  }
}

export async function transcribeVoice(
  oggData: Buffer | Uint8Array,
  config: Pick<Config, "openaiApiKey" | "openaiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const url = `${config.openaiBaseUrl.replace(/\/+$/u, "")}/audio/transcriptions`;
  const form = new FormData();
  const bytes = new Uint8Array(oggData.length);
  bytes.set(oggData);
  form.set("model", "gpt-4o-transcribe");
  form.set("file", new Blob([bytes], { type: "audio/ogg" }), "voice.ogg");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: form
  });

  if (!response.ok) {
    throw new TranscriptionHttpError(response.status, await response.text());
  }

  const payload = (await response.json()) as unknown;
  const text = isRecord(payload) && typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new EmptyTranscriptionError();
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
