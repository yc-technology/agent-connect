import { describe, expect, it } from "vitest";
import {
  EXPANDABLE_QUOTE_END,
  EXPANDABLE_QUOTE_START,
  TranscriptParser,
  type PendingToolInfo
} from "../src/agent-connect/transcriptParser.js";

function jsonlEntry(
  type = "assistant",
  content: unknown[] | string = "",
  timestamp = "2026-05-16T00:00:00.000Z"
) {
  return {
    type,
    message: { content },
    sessionId: "test-session-id",
    cwd: "/tmp/test",
    timestamp
  };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function toolUseBlock(id = "tool_1", name = "Read", input: Record<string, unknown> = {}) {
  return { type: "tool_use", id, name, input };
}

function toolResultBlock(
  toolUseId = "tool_1",
  content: unknown = "result text",
  isError = false
) {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

describe("TranscriptParser basics", () => {
  it("parses JSONL lines", () => {
    expect(TranscriptParser.parseLine('{"type": "user"}')).toEqual({ type: "user" });
    expect(TranscriptParser.parseLine("not-json")).toBeNull();
    expect(TranscriptParser.parseLine("   ")).toBeNull();
  });

  it("extracts text-only content", () => {
    expect(TranscriptParser.extractTextOnly("plain string")).toBe("plain string");
    expect(
      TranscriptParser.extractTextOnly([
        { type: "text", text: "hello" },
        { type: "tool_use", name: "Read" },
        { type: "text", text: "world" }
      ])
    ).toBe("hello\nworld");
    expect(TranscriptParser.extractTextOnly(42)).toBe("");
  });

  it("formats tool-use summaries", () => {
    expect(TranscriptParser.formatToolUseSummary("Read", { file_path: "src/main.ts" })).toBe(
      "**Read**(src/main.ts)"
    );
    expect(TranscriptParser.formatToolUseSummary("TodoWrite", { todos: [1, 2, 3] })).toBe(
      "**TodoWrite**(3 item(s))"
    );
    expect(
      TranscriptParser.formatToolUseSummary("AskUserQuestion", {
        questions: [{ question: "Continue?" }]
      })
    ).toBe("**AskUserQuestion**(Continue?)");
    expect(TranscriptParser.formatToolUseSummary("Read", "not a dict")).toBe("**Read**");
  });

  it("truncates long summaries", () => {
    const result = TranscriptParser.formatToolUseSummary("Bash", {
      command: "x".repeat(250)
    });
    expect(result).toBe(`**Bash**(${"x".repeat(200)}…)`);
  });

  it("extracts tool result text and images", () => {
    expect(
      TranscriptParser.extractToolResultText([
        { type: "text", text: "line1" },
        { type: "image", data: "..." },
        "line2"
      ])
    ).toBe("line1\nline2");

    const image = TranscriptParser.extractToolResultImages([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("png-data").toString("base64")
        }
      }
    ]);
    expect(image).toHaveLength(1);
    expect(image?.[0]?.mediaType).toBe("image/png");
    expect(image?.[0]?.data.toString()).toBe("png-data");
  });
});

describe("TranscriptParser message parsing", () => {
  it("parses user and assistant text", () => {
    expect(TranscriptParser.parseMessage(jsonlEntry("user", [textBlock("hello")]))).toEqual({
      messageType: "user",
      text: "hello"
    });
    expect(TranscriptParser.parseMessage(jsonlEntry("assistant", "plain response"))).toEqual({
      messageType: "assistant",
      text: "plain response"
    });
  });

  it("detects local command stdout and invoke entries", () => {
    const stdout = TranscriptParser.parseMessage(
      jsonlEntry("user", [
        textBlock(
          "<command-name>/help</command-name><local-command-stdout>Available commands</local-command-stdout>"
        )
      ])
    );
    expect(stdout).toEqual({
      messageType: "local_command",
      text: "Available commands",
      toolName: "/help"
    });

    expect(
      TranscriptParser.parseMessage(jsonlEntry("user", [textBlock("<command-name>/clear</command-name>")]))
    ).toEqual({
      messageType: "local_command_invoke",
      text: "",
      toolName: "/clear"
    });
  });
});

describe("TranscriptParser formatting", () => {
  it("formats edit diffs", () => {
    expect(TranscriptParser.formatEditDiff("hello", "world")).toContain("-hello");
    expect(TranscriptParser.formatEditDiff("hello", "world")).toContain("+world");
    expect(TranscriptParser.formatEditDiff("same", "same")).toBe("");
  });

  it("formats tool result text summaries", () => {
    expect(TranscriptParser.formatToolResultText("line1\nline2\nline3", "Read")).toBe(
      "  ⎿  Read 3 lines"
    );
    expect(TranscriptParser.formatToolResultText("line1\nline2", "Write")).toBe(
      "  ⎿  Wrote 2 lines"
    );
    expect(TranscriptParser.formatToolResultText("output", "Bash")).toContain(
      EXPANDABLE_QUOTE_START
    );
    expect(TranscriptParser.formatToolResultText("a.ts\nb.ts", "Glob")).toContain(
      "Found 2 files"
    );
    expect(TranscriptParser.formatToolResultText("", "Read")).toBe("");
  });
});

describe("TranscriptParser entries", () => {
  it("parses assistant and user text entries", () => {
    const [assistantEntries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [textBlock("Hello!")])
    ]);
    expect(assistantEntries[0]).toMatchObject({
      role: "assistant",
      text: "Hello!",
      contentType: "text"
    });

    const [userEntries] = TranscriptParser.parseEntries([jsonlEntry("user", [textBlock("Hi bot")])]);
    expect(userEntries[0]).toMatchObject({
      role: "user",
      text: "Hi bot",
      contentType: "text"
    });
  });

  it("pairs tool use and tool result entries", () => {
    const [entries, pending] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [toolUseBlock("t1", "Read", { file_path: "app.ts" })]),
      jsonlEntry("user", [toolResultBlock("t1", "file contents line1\nline2\nline3")])
    ]);
    expect(entries.filter((entry) => entry.contentType === "tool_use")).toHaveLength(1);
    expect(entries.filter((entry) => entry.contentType === "tool_result")).toHaveLength(1);
    expect(pending).toEqual({});
  });

  it("formats thinking and local command entries", () => {
    const [thinkingEntries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [{ type: "thinking", thinking: "reasoning here" }])
    ]);
    expect(thinkingEntries[0]?.contentType).toBe("thinking");
    expect(thinkingEntries[0]?.text).toContain(EXPANDABLE_QUOTE_START);
    expect(thinkingEntries[0]?.text).toContain(EXPANDABLE_QUOTE_END);

    const [localEntries] = TranscriptParser.parseEntries([
      jsonlEntry("user", [
        textBlock("<command-name>/status</command-name><local-command-stdout>all good</local-command-stdout>")
      ])
    ]);
    expect(localEntries[0]?.contentType).toBe("local_command");
    expect(localEntries[0]?.text).toContain("/status");
    expect(localEntries[0]?.text).toContain("all good");
  });

  it("emits a placeholder for empty thinking-only blocks", () => {
    const [entries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [{ type: "thinking" }])
    ]);

    expect(entries).toMatchObject([
      {
        role: "assistant",
        text: "(thinking)",
        contentType: "thinking"
      }
    ]);
  });

  it("emits ExitPlanMode plan text", () => {
    const [entries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [
        toolUseBlock("t1", "ExitPlanMode", { plan: "Step 1: do X\nStep 2: do Y" })
      ])
    ]);
    expect(entries.some((entry) => entry.contentType === "text" && entry.text.includes("Step 1"))).toBe(true);
    expect(entries.some((entry) => entry.contentType === "tool_use")).toBe(true);
  });

  it("adds edit diff stats to tool results", () => {
    const [entries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [
        toolUseBlock("t1", "Edit", {
          file_path: "main.ts",
          old_string: "old line",
          new_string: "new line"
        })
      ]),
      jsonlEntry("user", [toolResultBlock("t1", "OK")])
    ]);
    const toolResult = entries.find((entry) => entry.contentType === "tool_result");
    expect(toolResult?.text).toContain("Added");
    expect(toolResult?.text).toContain("removed");
    expect(toolResult?.text).toContain(EXPANDABLE_QUOTE_START);
  });

  it("handles error and interrupted tool results", () => {
    const [errorEntries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [toolUseBlock("t1", "Bash", { command: "rm -rf /" })]),
      jsonlEntry("user", [toolResultBlock("t1", "Permission denied", true)])
    ]);
    expect(errorEntries.find((entry) => entry.contentType === "tool_result")?.text).toContain(
      "Error: Permission denied"
    );

    const [interruptedEntries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [toolUseBlock("t1", "Read", { file_path: "x.ts" })]),
      jsonlEntry("user", [toolResultBlock("t1", TranscriptParser.INTERRUPTED_TEXT)])
    ]);
    expect(interruptedEntries.find((entry) => entry.contentType === "tool_result")?.text).toContain(
      "Interrupted"
    );
  });

  it("keeps pending tools in carry-over mode and flushes in one-shot mode", () => {
    const carryOver: Record<string, PendingToolInfo> = {};
    const [carryEntries, carryPending] = TranscriptParser.parseEntries(
      [jsonlEntry("assistant", [toolUseBlock("t1", "Read", { file_path: "a.ts" })])],
      carryOver
    );
    expect(carryEntries.filter((entry) => entry.contentType === "tool_use" && entry.toolUseId === "t1")).toHaveLength(1);
    expect(carryPending.t1).toBeDefined();

    const [oneShotEntries] = TranscriptParser.parseEntries([
      jsonlEntry("assistant", [toolUseBlock("t1", "Read", { file_path: "a.ts" })])
    ]);
    expect(oneShotEntries.filter((entry) => entry.contentType === "tool_use" && entry.toolUseId === "t1")).toHaveLength(2);
  });

  it("filters system tags from user messages", () => {
    const [entries] = TranscriptParser.parseEntries([
      jsonlEntry("user", [textBlock("<system-reminder>secret</system-reminder>")])
    ]);
    expect(entries.filter((entry) => entry.role === "user")).toHaveLength(0);
  });

  it("parses Codex response items", () => {
    const [entries] = TranscriptParser.parseEntries([
      {
        type: "response_item",
        timestamp: "2026-05-16T00:00:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex response" }]
        }
      },
      {
        type: "response_item",
        timestamp: "2026-05-16T00:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "User prompt" }]
        }
      }
    ]);

    expect(entries).toMatchObject([
      { role: "assistant", text: "Codex response", contentType: "text" },
      { role: "user", text: "User prompt", contentType: "text" }
    ]);
  });

  it("pairs Codex function calls and outputs", () => {
    const [entries, pending] = TranscriptParser.parseEntries(
      [
        {
          type: "response_item",
          timestamp: "2026-05-16T00:00:00.000Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_1",
            arguments: JSON.stringify({ cmd: "pnpm test" })
          }
        },
        {
          type: "response_item",
          timestamp: "2026-05-16T00:00:01.000Z",
          payload: {
            type: "function_call_output",
            call_id: "call_1",
            output: "tests passed"
          }
        }
      ],
      {}
    );

    expect(entries[0]).toMatchObject({
      contentType: "tool_use",
      toolUseId: "call_1",
      toolName: "exec_command"
    });
    expect(entries[0]?.text).toContain("pnpm test");
    expect(entries[1]).toMatchObject({
      contentType: "tool_result",
      toolUseId: "call_1"
    });
    expect(entries[1]?.text).toContain("tests passed");
    expect(pending).toEqual({});
  });

  it("parses Codex reasoning summaries without fake placeholders", () => {
    const [emptyEntries] = TranscriptParser.parseEntries([
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: []
        }
      }
    ]);
    expect(emptyEntries).toEqual([]);

    const [entries] = TranscriptParser.parseEntries([
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "reasoning summary" }]
        }
      }
    ]);
    expect(entries[0]).toMatchObject({
      role: "assistant",
      contentType: "thinking"
    });
    expect(entries[0]?.text).toContain("reasoning summary");
  });
});
