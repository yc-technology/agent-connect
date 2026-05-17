import { splitMessage } from "./telegramSender.js";
import { EXPANDABLE_QUOTE_END, EXPANDABLE_QUOTE_START } from "./transcriptParser.js";

export function buildResponseParts(
  rawText: string,
  isComplete: boolean,
  contentType = "text",
  role: "user" | "assistant" = "assistant"
): string[] {
  let text = rawText.trim();

  if (role === "user") {
    if (text.length > 3000) {
      text = `${text.slice(0, 3000)}…`;
    }
    return [`👤 ${text}`];
  }

  if (contentType === "thinking" && isComplete) {
    const maxThinking = 500;
    if (text.includes(EXPANDABLE_QUOTE_START) && text.includes(EXPANDABLE_QUOTE_END)) {
      const start = text.indexOf(EXPANDABLE_QUOTE_START) + EXPANDABLE_QUOTE_START.length;
      const end = text.indexOf(EXPANDABLE_QUOTE_END);
      let inner = text.slice(start, end);
      if (inner.length > maxThinking) {
        inner = `${inner.slice(0, maxThinking)}\n\n… (thinking truncated)`;
      }
      text = `${EXPANDABLE_QUOTE_START}${inner}${EXPANDABLE_QUOTE_END}`;
    } else if (text.length > maxThinking) {
      text = `${text.slice(0, maxThinking)}\n\n… (thinking truncated)`;
    }
  }

  const prefix = contentType === "thinking" ? "∴ Thinking…" : "";
  const separator = prefix ? "\n" : "";

  if (text.includes(EXPANDABLE_QUOTE_START)) {
    return [prefix ? `${prefix}${separator}${text}` : text];
  }

  const maxText = 3000 - prefix.length - separator.length;
  const chunks = splitMessage(text, maxText);
  if (chunks.length === 1) {
    return [prefix ? `${prefix}${separator}${chunks[0]}` : chunks[0] ?? ""];
  }

  return chunks.map((chunk, index) => {
    const body = prefix ? `${prefix}${separator}${chunk}` : chunk;
    return `${body}\n\n[${index + 1}/${chunks.length}]`;
  });
}
