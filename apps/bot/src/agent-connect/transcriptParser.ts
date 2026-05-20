export interface ParsedMessage {
  messageType: string;
  text: string;
  toolName?: string | null;
}

export interface ParsedEntry {
  role: "user" | "assistant";
  text: string;
  contentType: string;
  toolUseId?: string | null;
  timestamp?: string | null;
  toolName?: string | null;
  imageData?: ToolResultImage[] | null;
}

export interface PendingToolInfo {
  summary: string;
  toolName: string;
  inputData?: unknown;
}

export interface ToolResultImage {
  mediaType: string;
  data: Buffer;
  // Optional override for the Telegram document filename. Set by callers that
  // know the real on-disk filename (e.g. `agc send /tmp/build.zip` → `build.zip`).
  // When unset, sendImagesAsDocuments synthesizes one from mediaType.
  filename?: string;
}

type JsonRecord = Record<string, unknown>;

const NO_CONTENT_PLACEHOLDER = "(no content)";
const INTERRUPTED_TEXT = "[Request interrupted by user for tool use]";
const MAX_SUMMARY_LENGTH = 200;

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;
const LOCAL_STDOUT_RE = /<local-command-stdout>(.*?)<\/local-command-stdout>/s;
const SYSTEM_TAGS_RE =
  /<(bash-input|bash-stdout|bash-stderr|local-command-caveat|system-reminder)/;

export const EXPANDABLE_QUOTE_START = "\x02EXPQUOTE_START\x02";
export const EXPANDABLE_QUOTE_END = "\x02EXPQUOTE_END\x02";

export class TranscriptParser {
  static readonly EXPANDABLE_QUOTE_START = EXPANDABLE_QUOTE_START;
  static readonly EXPANDABLE_QUOTE_END = EXPANDABLE_QUOTE_END;
  static readonly INTERRUPTED_TEXT = INTERRUPTED_TEXT;

  static parseLine(line: string): JsonRecord | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  static getMessageType(data: JsonRecord): string | null {
    return typeof data.type === "string" ? data.type : null;
  }

  static isUserMessage(data: JsonRecord): boolean {
    return data.type === "user";
  }

  static extractTextOnly(contentList: unknown): string {
    if (!Array.isArray(contentList)) {
      return typeof contentList === "string" ? contentList : "";
    }

    const texts: string[] = [];
    for (const item of contentList) {
      if (typeof item === "string") {
        texts.push(item);
      } else if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text) {
        texts.push(item.text);
      }
    }
    return texts.join("\n");
  }

  static formatEditDiff(oldString: string, newString: string): string {
    const oldLines = splitLinesComparable(oldString);
    const newLines = splitLinesComparable(newString);
    if (arraysEqual(oldLines, newLines)) return "";

    const result: string[] = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      const oldLine = oldLines[oldIndex];
      const newLine = newLines[newIndex];

      if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
        result.push(` ${oldLine}`);
        oldIndex += 1;
        newIndex += 1;
        continue;
      }

      const nextOld = oldLines[oldIndex + 1];
      const nextNew = newLines[newIndex + 1];
      if (oldLine !== undefined && nextOld === newLine) {
        result.push(`-${oldLine}`);
        oldIndex += 1;
      } else if (newLine !== undefined && oldLine === nextNew) {
        result.push(`+${newLine}`);
        newIndex += 1;
      } else {
        if (oldLine !== undefined) {
          result.push(`-${oldLine}`);
          oldIndex += 1;
        }
        if (newLine !== undefined) {
          result.push(`+${newLine}`);
          newIndex += 1;
        }
      }
    }

    return result.join("\n");
  }

  static formatToolUseSummary(name: string, inputData: unknown): string {
    if (!isRecord(inputData)) {
      return `**${name}**`;
    }

    let summary = "";
    if (name === "Read" || name === "Glob") {
      summary = firstString(inputData.file_path, inputData.pattern);
    } else if (name === "Write") {
      summary = firstString(inputData.file_path);
    } else if (name === "Edit" || name === "NotebookEdit") {
      summary = firstString(inputData.file_path, inputData.notebook_path);
    } else if (name === "Bash" || name === "exec_command") {
      summary = firstString(inputData.command, inputData.cmd);
    } else if (name === "write_stdin") {
      summary = firstString(inputData.session_id, inputData.chars);
    } else if (name === "view_image") {
      summary = firstString(inputData.path);
    } else if (name === "apply_patch") {
      summary = firstString(inputData.patch);
    } else if (name === "update_plan") {
      summary = "plan";
    } else if (name === "spawn_agent") {
      summary = firstString(inputData.message, inputData.agent_type);
    } else if (name === "wait_agent") {
      summary = Array.isArray(inputData.targets) ? `${inputData.targets.length} target(s)` : "";
    } else if (name === "Grep") {
      summary = firstString(inputData.pattern);
    } else if (name === "Task") {
      summary = firstString(inputData.description);
    } else if (name === "WebFetch") {
      summary = firstString(inputData.url);
    } else if (name === "WebSearch") {
      summary = firstString(inputData.query);
    } else if (name === "TodoWrite") {
      summary = Array.isArray(inputData.todos) ? `${inputData.todos.length} item(s)` : "";
    } else if (name === "TodoRead") {
      summary = "";
    } else if (name === "AskUserQuestion") {
      const questions = inputData.questions;
      const firstQuestion = Array.isArray(questions) ? questions[0] : undefined;
      summary = isRecord(firstQuestion) ? firstString(firstQuestion.question) : "";
    } else if (name === "ExitPlanMode") {
      summary = "";
    } else if (name === "Skill") {
      summary = firstString(inputData.skill);
    } else {
      for (const value of Object.values(inputData)) {
        if (typeof value === "string" && value) {
          summary = value;
          break;
        }
      }
    }

    if (summary) {
      if (summary.length > MAX_SUMMARY_LENGTH) {
        summary = `${summary.slice(0, MAX_SUMMARY_LENGTH)}…`;
      }
      return `**${name}**(${summary})`;
    }
    return `**${name}**`;
  }

  static extractToolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text) {
        parts.push(item.text);
      }
    }
    return parts.join("\n");
  }

  static extractToolResultImages(content: unknown): ToolResultImage[] | null {
    if (!Array.isArray(content)) return null;

    const images: ToolResultImage[] = [];
    for (const item of content) {
      if (!isRecord(item) || item.type !== "image") continue;
      const source = item.source;
      if (!isRecord(source) || source.type !== "base64") continue;

      const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
      if (typeof source.data !== "string" || !source.data) continue;
      try {
        images.push({
          mediaType,
          data: Buffer.from(source.data, "base64")
        });
      } catch {
        continue;
      }
    }
    return images.length > 0 ? images : null;
  }

  static parseMessage(data: JsonRecord): ParsedMessage | null {
    const msgType = this.getMessageType(data);
    if (msgType !== "user" && msgType !== "assistant") return null;

    const message = data.message;
    if (!isRecord(message)) return null;

    const content = message.content ?? "";
    const text = (Array.isArray(content)
      ? this.extractTextOnly(content)
      : content
        ? String(content)
        : ""
    ).replace(ANSI_ESCAPE_RE, "");

    if (msgType === "user" && text) {
      const stdoutMatch = LOCAL_STDOUT_RE.exec(text);
      if (stdoutMatch) {
        const cmdMatch = COMMAND_NAME_RE.exec(text);
        return {
          messageType: "local_command",
          text: (stdoutMatch[1] ?? "").trim(),
          toolName: cmdMatch?.[1] ?? null
        };
      }

      const cmdMatch = COMMAND_NAME_RE.exec(text);
      if (cmdMatch) {
        return {
          messageType: "local_command_invoke",
          text: "",
          toolName: cmdMatch[1] ?? null
        };
      }
    }

    return {
      messageType: msgType,
      text
    };
  }

  static getTimestamp(data: JsonRecord): string | null {
    return typeof data.timestamp === "string" ? data.timestamp : null;
  }

  static formatExpandableQuote(text: string): string {
    return `${EXPANDABLE_QUOTE_START}${text}${EXPANDABLE_QUOTE_END}`;
  }

  static formatToolResultText(
    text: string,
    toolName: string | null = null,
    toolInputData: unknown = null
  ): string {
    if (!text) return "";

    const lineCount = text.split("\n").length;

    if (toolName === "Read") {
      return `  ⎿  Read ${lineCount} lines`;
    }

    if (toolName === "Write") {
      const written = isRecord(toolInputData) && typeof toolInputData.content === "string"
        ? toolInputData.content
        : text;
      const writtenLines = written
        ? written.split("\n").length - (written.endsWith("\n") ? 1 : 0)
        : 0;
      return `  ⎿  Wrote ${writtenLines} lines`;
    }

    if (toolName === "Bash" || toolName === "exec_command" || toolName === "write_stdin") {
      return `  ⎿  Output ${lineCount} lines\n${this.formatExpandableQuote(text)}`;
    }

    if (toolName === "Grep") {
      const matches = text.split("\n").filter((line) => line.trim()).length;
      return `  ⎿  Found ${matches} matches\n${this.formatExpandableQuote(text)}`;
    }

    if (toolName === "Glob") {
      const files = text.split("\n").filter((line) => line.trim()).length;
      return `  ⎿  Found ${files} files\n${this.formatExpandableQuote(text)}`;
    }

    if (toolName === "Task") {
      return `  ⎿  Agent output ${lineCount} lines\n${this.formatExpandableQuote(text)}`;
    }

    if (toolName === "WebFetch") {
      return `  ⎿  Fetched ${text.length} characters\n${this.formatExpandableQuote(text)}`;
    }

    if (toolName === "WebSearch") {
      const results = text ? text.split("\n\n").length : 0;
      return `  ⎿  ${results} search results\n${this.formatExpandableQuote(text)}`;
    }

    return this.formatExpandableQuote(text);
  }

  static parseEntries(
    entries: JsonRecord[],
    pendingTools?: Record<string, PendingToolInfo>
  ): [ParsedEntry[], Record<string, PendingToolInfo>] {
    const result: ParsedEntry[] = [];
    let lastCmdName: string | null = null;
    const carryOver = pendingTools !== undefined;
    const pending: Record<string, PendingToolInfo> = { ...(pendingTools ?? {}) };

    for (const data of entries) {
      const codexEntries = this.parseCodexEntry(data, pending);
      if (codexEntries) {
        result.push(...codexEntries);
        continue;
      }

      const msgType = this.getMessageType(data);
      if (msgType !== "user" && msgType !== "assistant") continue;

      const entryTimestamp = this.getTimestamp(data);
      const message = data.message;
      if (!isRecord(message)) continue;

      const rawContent = message.content ?? "";
      const content: unknown[] = Array.isArray(rawContent)
        ? rawContent
        : rawContent
          ? [{ type: "text", text: String(rawContent) }]
          : [];

      const parsed = this.parseMessage(data);

      if (parsed) {
        if (parsed.messageType === "local_command_invoke") {
          lastCmdName = parsed.toolName ?? null;
          continue;
        }
        if (parsed.messageType === "local_command") {
          const cmd = parsed.toolName ?? lastCmdName ?? "";
          const text = parsed.text;
          let formatted: string;
          if (cmd) {
            formatted = text.includes("\n") ? `❯ \`${cmd}\`\n\`\`\`\n${text}\n\`\`\`` : `❯ \`${cmd}\`\n\`${text}\``;
          } else {
            formatted = text.includes("\n") ? `\`\`\`\n${text}\n\`\`\`` : `\`${text}\``;
          }
          result.push({
            role: "assistant",
            text: formatted,
            contentType: "local_command",
            timestamp: entryTimestamp
          });
          lastCmdName = null;
          continue;
        }
      }
      lastCmdName = null;

      if (msgType === "assistant") {
        let hasText = false;
        for (const block of content) {
          if (!isRecord(block)) continue;
          const blockType = block.type;

          if (blockType === "text") {
            const text = typeof block.text === "string" ? block.text.trim() : "";
            if (text && text !== NO_CONTENT_PLACEHOLDER) {
              result.push({
                role: "assistant",
                text,
                contentType: "text",
                timestamp: entryTimestamp
              });
              hasText = true;
            }
          } else if (blockType === "tool_use") {
            const toolId = typeof block.id === "string" ? block.id : "";
            const name = typeof block.name === "string" ? block.name : "unknown";
            const input = block.input ?? {};
            const summary = this.formatToolUseSummary(name, input);

            if (name === "ExitPlanMode" && isRecord(input) && typeof input.plan === "string" && input.plan) {
              result.push({
                role: "assistant",
                text: input.plan,
                contentType: "text",
                timestamp: entryTimestamp
              });
            }

            if (toolId) {
              pending[toolId] = {
                summary,
                toolName: name,
                inputData: ["Edit", "NotebookEdit", "Write"].includes(name) ? input : undefined
              };
            }

            result.push({
              role: "assistant",
              text: summary,
              contentType: "tool_use",
              toolUseId: toolId || null,
              timestamp: entryTimestamp,
              toolName: name
            });
          } else if (blockType === "thinking") {
            const thinkingText = typeof block.thinking === "string" ? block.thinking : "";
            if (thinkingText) {
              result.push({
                role: "assistant",
                text: this.formatExpandableQuote(thinkingText),
                contentType: "thinking",
                timestamp: entryTimestamp
              });
            } else if (!hasText) {
              result.push({
                role: "assistant",
                text: "(thinking)",
                contentType: "thinking",
                timestamp: entryTimestamp
              });
            }
          }
        }
      } else {
        const userTextParts: string[] = [];

        for (const block of content) {
          if (!isRecord(block)) {
            if (typeof block === "string" && block.trim()) {
              userTextParts.push(block.trim());
            }
            continue;
          }

          const blockType = block.type;
          if (blockType === "tool_result") {
            const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            const resultContent = block.content ?? "";
            const resultText = this.extractToolResultText(resultContent);
            const resultImages = this.extractToolResultImages(resultContent);
            const isError = block.is_error === true;
            const isInterrupted = resultText === INTERRUPTED_TEXT;
            const toolInfo = toolUseId ? pending[toolUseId] : undefined;
            if (toolUseId) delete pending[toolUseId];

            const toolSummary = toolInfo?.summary ?? null;
            const toolName = toolInfo?.toolName ?? null;
            const toolInputData = toolInfo?.inputData ?? null;
            const normalizedToolUseId = toolUseId || null;

            if (isInterrupted) {
              const entryText = toolSummary ? `${toolSummary}\n⏹ Interrupted` : "⏹ Interrupted";
              result.push({
                role: "assistant",
                text: entryText,
                contentType: "tool_result",
                toolUseId: normalizedToolUseId,
                timestamp: entryTimestamp
              });
            } else if (isError) {
              let entryText = toolSummary ?? "**Error**";
              if (resultText) {
                let errorSummary = resultText.split("\n")[0] ?? "";
                if (errorSummary.length > 100) {
                  errorSummary = `${errorSummary.slice(0, 100)}…`;
                }
                entryText += `\n  ⎿  Error: ${errorSummary}`;
                if (resultText.includes("\n")) {
                  entryText += `\n${this.formatExpandableQuote(resultText)}`;
                }
              } else {
                entryText += "\n  ⎿  Error";
              }
              result.push({
                role: "assistant",
                text: entryText,
                contentType: "tool_result",
                toolUseId: normalizedToolUseId,
                timestamp: entryTimestamp,
                imageData: resultImages
              });
            } else if (toolSummary) {
              let entryText = toolSummary;
              if (toolName === "Edit" && isRecord(toolInputData) && resultText) {
                const oldString = typeof toolInputData.old_string === "string" ? toolInputData.old_string : "";
                const newString = typeof toolInputData.new_string === "string" ? toolInputData.new_string : "";
                if (oldString && newString) {
                  const diffText = this.formatEditDiff(oldString, newString);
                  if (diffText) {
                    const added = diffText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
                    const removed = diffText.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
                    entryText += `\n  ⎿  Added ${added} lines, removed ${removed} lines\n${this.formatExpandableQuote(diffText)}`;
                  }
                }
              } else if (resultText && !toolSummary.includes(EXPANDABLE_QUOTE_START)) {
                entryText += `\n${this.formatToolResultText(resultText, toolName, toolInputData)}`;
              }
              result.push({
                role: "assistant",
                text: entryText,
                contentType: "tool_result",
                toolUseId: normalizedToolUseId,
                timestamp: entryTimestamp,
                imageData: resultImages
              });
            } else if (resultText || resultImages) {
              result.push({
                role: "assistant",
                text: resultText ? this.formatToolResultText(resultText, toolName, toolInputData) : "",
                contentType: "tool_result",
                toolUseId: normalizedToolUseId,
                timestamp: entryTimestamp,
                imageData: resultImages
              });
            }
          } else if (blockType === "text") {
            const text = typeof block.text === "string" ? block.text.trim() : "";
            if (text && !SYSTEM_TAGS_RE.test(text)) {
              userTextParts.push(text);
            }
          }
        }

        if (userTextParts.length > 0) {
          const combined = userTextParts.join("\n");
          if (!LOCAL_STDOUT_RE.test(combined) && !COMMAND_NAME_RE.test(combined)) {
            result.push({
              role: "user",
              text: combined,
              contentType: "text",
              timestamp: entryTimestamp
            });
          }
        }
      }
    }

    const remainingPending = { ...pending };
    if (!carryOver) {
      for (const [toolId, toolInfo] of Object.entries(pending)) {
        result.push({
          role: "assistant",
          text: toolInfo.summary,
          contentType: "tool_use",
          toolUseId: toolId
        });
      }
    }

    for (const entry of result) {
      entry.text = entry.text.trim();
    }

    return [result, remainingPending];
  }

  private static parseCodexEntry(
    data: JsonRecord,
    pending: Record<string, PendingToolInfo>
  ): ParsedEntry[] | null {
    if (data.type !== "response_item" || !isRecord(data.payload)) return null;
    const payload = data.payload;
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    const timestamp = this.getTimestamp(data);

    if (payloadType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") return [];
      const text = this.extractCodexMessageText(payload.content).trim();
      if (!text) return [];
      return [
        {
          role,
          text,
          contentType: "text",
          timestamp
        }
      ];
    }

    if (payloadType === "reasoning") {
      const text = this.extractCodexReasoningText(payload).trim();
      if (!text) return [];
      return [
        {
          role: "assistant",
          text: this.formatExpandableQuote(text),
          contentType: "thinking",
          timestamp
        }
      ];
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "web_search_call") {
      const toolId = firstString(payload.call_id, payload.id);
      const name = typeof payload.name === "string" && payload.name ? payload.name : payloadType;
      const input = this.parseCodexToolInput(payload.arguments ?? payload.input);
      const summary = this.formatToolUseSummary(name, input);

      if (toolId) {
        pending[toolId] = {
          summary,
          toolName: name,
          inputData: input
        };
      }

      return [
        {
          role: "assistant",
          text: summary,
          contentType: "tool_use",
          toolUseId: toolId || null,
          timestamp,
          toolName: name
        }
      ];
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const toolId = firstString(payload.call_id, payload.id);
      const toolInfo = toolId ? pending[toolId] : undefined;
      if (toolId) delete pending[toolId];

      const output = this.extractCodexToolOutput(payload.output).trim();
      const toolName = toolInfo?.toolName ?? null;
      let text = toolInfo?.summary ?? (toolName ? `**${toolName}**` : "**Tool result**");
      if (output) {
        text += `\n${this.formatToolResultText(output, toolName, toolInfo?.inputData)}`;
      }

      return [
        {
          role: "assistant",
          text,
          contentType: "tool_result",
          toolUseId: toolId || null,
          timestamp,
          toolName
        }
      ];
    }

    return [];
  }

  private static extractCodexMessageText(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === "string" ? content : "";
    const parts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) {
        if (typeof item === "string" && item) parts.push(item);
        continue;
      }
      const blockType = item.type;
      const text = typeof item.text === "string" ? item.text : "";
      if (text && (blockType === "input_text" || blockType === "output_text" || blockType === "text")) {
        parts.push(text);
      }
    }
    return parts.join("\n");
  }

  private static extractCodexReasoningText(payload: JsonRecord): string {
    const parts: string[] = [];
    const summary = payload.summary;
    if (Array.isArray(summary)) {
      for (const item of summary) {
        if (!isRecord(item)) continue;
        const text = typeof item.text === "string" ? item.text : "";
        if (text) parts.push(text);
      }
    } else if (typeof summary === "string" && summary) {
      parts.push(summary);
    }

    const content = payload.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!isRecord(item)) continue;
        const text = typeof item.text === "string" ? item.text : "";
        if (text) parts.push(text);
      }
    }

    return parts.join("\n");
  }

  private static parseCodexToolInput(input: unknown): unknown {
    if (typeof input !== "string") return input ?? {};
    try {
      const parsed = JSON.parse(input) as unknown;
      return isRecord(parsed) ? parsed : { value: input };
    } catch {
      return { value: input };
    }
  }

  private static extractCodexToolOutput(output: unknown): string {
    if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output) as unknown;
        if (isRecord(parsed) && typeof parsed.output === "string") return parsed.output;
      } catch {
        // Plain string output is common for function_call_output.
      }
      return output;
    }
    if (Array.isArray(output)) return this.extractToolResultText(output);
    if (isRecord(output) && typeof output.output === "string") return output.output;
    return "";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function splitLinesComparable(value: string): string[] {
  if (value === "") return [""];
  return value.split(/\r?\n/);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
