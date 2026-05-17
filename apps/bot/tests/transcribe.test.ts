import { describe, expect, it, vi } from "vitest";
import {
  EmptyTranscriptionError,
  transcribeVoice,
  TranscriptionHttpError
} from "../src/agent-connect/transcribe.js";

const config = {
  openaiApiKey: "sk-test",
  openaiBaseUrl: "https://proxy.example.com/v1/"
};

describe("transcribeVoice", () => {
  it("posts OGG data and returns trimmed text", async () => {
    const calls: Array<[Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]> = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ text: "  Hello world  " }));
    });

    const result = await transcribeVoice(Buffer.from("fake-ogg-data"), config, fetchMock);

    expect(result).toBe("Hello world");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(calls[0]?.[0]).toBe("https://proxy.example.com/v1/audio/transcriptions");
    const init = calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("raises on empty transcription", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "   " })));
    await expect(transcribeVoice(Buffer.from("x"), config, fetchMock)).rejects.toBeInstanceOf(
      EmptyTranscriptionError
    );
  });

  it("raises on HTTP errors", async () => {
    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    await expect(transcribeVoice(Buffer.from("x"), config, fetchMock)).rejects.toMatchObject({
      status: 401
    } satisfies Partial<TranscriptionHttpError>);
  });
});
