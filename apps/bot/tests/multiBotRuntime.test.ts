import { describe, expect, it } from "vitest";
import { isPollingConflict } from "../src/agent-connect/multiBotRuntime.js";

describe("isPollingConflict", () => {
  it("detects a grammy GrammyError with error_code 409", () => {
    // Shape grammy throws when getUpdates conflicts with another long-poll.
    const err = {
      error_code: 409,
      description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      ok: false
    };
    expect(isPollingConflict(err)).toBe(true);
  });

  it("detects 409 from the message text when the numeric code is absent", () => {
    const err = new Error(
      "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request)"
    );
    expect(isPollingConflict(err)).toBe(true);
  });

  it("does not match other Telegram errors", () => {
    expect(isPollingConflict({ error_code: 400, description: "Bad Request: query is too old" })).toBe(false);
    expect(isPollingConflict({ error_code: 401, description: "Unauthorized" })).toBe(false);
    expect(isPollingConflict(new Error("ETIMEDOUT"))).toBe(false);
  });

  it("does not match 409 without the word conflict (avoid false positives on unrelated text)", () => {
    // e.g. a message that happens to contain "409" but isn't a poll conflict
    expect(isPollingConflict(new Error("processed 409 updates"))).toBe(false);
  });

  it("is null/undefined/non-object safe", () => {
    expect(isPollingConflict(null)).toBe(false);
    expect(isPollingConflict(undefined)).toBe(false);
    expect(isPollingConflict("409 conflict")).toBe(false);
    expect(isPollingConflict(409)).toBe(false);
  });
});
