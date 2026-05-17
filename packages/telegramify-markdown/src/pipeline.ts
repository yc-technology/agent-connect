import { convertWithSegments, type Segment } from "./converter.js";
import { ContentType, fileContent, textContent, type TelegramContent, type Text } from "./content.js";
import { createMessageEntity, splitEntities, utf16Len, type MessageEntity } from "./entity.js";

export async function processMarkdown(
  content: string,
  options: {
    maxMessageLength?: number;
    max_message_length?: number;
    latexEscape?: boolean;
    latex_escape?: boolean;
    renderMermaid?: boolean;
    render_mermaid?: boolean;
    minFileLines?: number;
    min_file_lines?: number;
  } = {}
): Promise<TelegramContent[]> {
  const maxMessageLength = options.maxMessageLength ?? options.max_message_length ?? 4096;
  const latexEscape = options.latexEscape ?? options.latex_escape ?? true;
  const renderMermaid = options.renderMermaid ?? options.render_mermaid ?? true;
  const minFileLines = options.minFileLines ?? options.min_file_lines ?? 1;

  const [fullText, fullEntities, segments] = convertWithSegments(content, {
    latexEscape
  });
  const result: TelegramContent[] = [];
  const specialSegments = segments
    .filter(
      (segment) =>
        (segment.kind === "code_block" &&
          minFileLines > 0 &&
          segment.rawCode.split("\n").length >= minFileLines) ||
        (segment.kind === "mermaid" && renderMermaid)
    )
    .sort((a, b) => a.textStart - b.textStart);

  let cursor = 0;
  for (const segment of specialSegments) {
    if (segment.textStart > cursor) {
      appendTextSlice(result, fullText, fullEntities, cursor, segment.textStart, maxMessageLength);
    }

    if (segment.kind === "mermaid") {
      handleMermaid(result, segment);
    } else {
      handleCodeBlock(result, segment);
    }
    cursor = segment.textEnd;
  }

  if (cursor < fullText.length) {
    appendTextSlice(result, fullText, fullEntities, cursor, fullText.length, maxMessageLength);
  }

  if (result.length === 0 && fullText.trim()) {
    appendTextChunks(result, fullText.trim(), fullEntities, maxMessageLength);
  }

  return result;
}

function appendTextSlice(
  result: TelegramContent[],
  fullText: string,
  fullEntities: MessageEntity[],
  start: number,
  end: number,
  maxMessageLength: number
): void {
  const text = fullText.slice(start, end);
  const entities = sliceEntities(fullEntities, start, end);
  const [strippedText, strippedEntities] = stripNewlinesAdjust(text, entities);
  if (strippedText) appendTextChunks(result, strippedText, strippedEntities, maxMessageLength);
}

function appendTextChunks(
  result: TelegramContent[],
  text: string,
  entities: MessageEntity[],
  maxMessageLength: number
): void {
  for (const [chunkText, chunkEntities] of splitEntities(text, entities, maxMessageLength)) {
    const [strippedText, strippedEntities] = stripNewlinesAdjust(chunkText, chunkEntities);
    if (strippedText) result.push(textContent(strippedText, strippedEntities));
  }
}

function sliceEntities(entities: MessageEntity[], start: number, end: number): MessageEntity[] {
  const sliced: MessageEntity[] = [];
  for (const entity of entities) {
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;
    if (entityEnd <= start || entityStart >= end) continue;
    const clippedStart = Math.max(entityStart, start);
    const clippedEnd = Math.min(entityEnd, end);
    if (clippedEnd <= clippedStart) continue;
    sliced.push(
      createMessageEntity({
        ...entity,
        offset: clippedStart - start,
        length: clippedEnd - clippedStart
      })
    );
  }
  return sliced;
}

function stripNewlinesAdjust(text: string, entities: MessageEntity[]): [string, MessageEntity[]] {
  const leading = /^\n*/.exec(text)?.[0].length ?? 0;
  const trailing = /\n*$/.exec(text)?.[0].length ?? 0;
  if (leading === 0 && trailing === 0) return [text, entities];

  const end = trailing > 0 ? text.length - trailing : text.length;
  const stripped = text.slice(leading, end);
  if (!stripped) return ["", []];

  const newLength = utf16Len(stripped);
  const adjusted: MessageEntity[] = [];
  for (const entity of entities) {
    const newOffset = entity.offset - leading;
    const newEnd = newOffset + entity.length;
    if (newEnd <= 0 || newOffset >= newLength) continue;
    const clippedStart = Math.max(0, newOffset);
    const clippedEnd = Math.min(newEnd, newLength);
    if (clippedEnd <= clippedStart) continue;
    adjusted.push(
      createMessageEntity({
        ...entity,
        offset: clippedStart,
        length: clippedEnd - clippedStart
      })
    );
  }

  return [stripped, adjusted];
}

function handleCodeBlock(result: TelegramContent[], segment: Segment): void {
  const language = segment.language || "txt";
  result.push(
    fileContent(`code.${extensionForLanguage(language)}`, Buffer.from(segment.rawCode, "utf8"), {
      sourceType: "file",
      extra: { language }
    })
  );
}

function handleMermaid(result: TelegramContent[], segment: Segment): void {
  result.push(
    fileContent("mermaid.txt", Buffer.from(segment.rawCode, "utf8"), {
      sourceType: "mermaid"
    })
  );
}

function extensionForLanguage(language: string): string {
  const map: Record<string, string> = {
    javascript: "js",
    typescript: "ts",
    python: "py",
    bash: "sh",
    shell: "sh",
    mermaid: "mmd"
  };
  return map[language.toLowerCase()] || language.toLowerCase() || "txt";
}

export const process_markdown = processMarkdown;
export type { Text };
export { ContentType };
