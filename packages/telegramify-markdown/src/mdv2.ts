import { createMessageEntity, splitEntities, utf16Len, type MessageEntity } from "./entity.js";

const MDV2_ESCAPE_CHARS = new Set("_*[]()~`>#+-=|{}.!\\".split(""));
const CODE_ESCAPE_CHARS = new Set("`\\".split(""));
const URL_ESCAPE_CHARS = new Set(")\\".split(""));
const SIMPLE_MARKERS: Record<string, [string, string]> = {
  bold: ["*", "*"],
  italic: ["_", "_"],
  underline: ["__", "__"],
  strikethrough: ["~", "~"],
  spoiler: ["||", "||"]
};
const CODE_ENTITY_TYPES = new Set(["code", "pre"]);

export function escapeMarkdownV2(text: string): string {
  return escapeWithSet(text, MDV2_ESCAPE_CHARS);
}

export function escapeCode(text: string): string {
  return escapeWithSet(text, CODE_ESCAPE_CHARS);
}

export function escapeUrl(text: string): string {
  return escapeWithSet(text, URL_ESCAPE_CHARS);
}

export function entitiesToMarkdownV2(text: string, entities: MessageEntity[] = []): string {
  if (!text) return "";
  if (entities.length === 0) return escapeMarkdownV2(text);

  const blockquotes: Array<{ start: number; end: number; type: string }> = [];
  const otherEntities: MessageEntity[] = [];
  for (const entity of entities) {
    if (entity.type === "blockquote" || entity.type === "expandable_blockquote") {
      blockquotes.push({
        start: entity.offset,
        end: entity.offset + entity.length,
        type: entity.type
      });
    } else {
      otherEntities.push(entity);
    }
  }

  const events: Array<{
    position: number;
    eventType: 0 | 1;
    lengthSort: number;
    sequenceSort: number;
    sequence: number;
    entity: MessageEntity;
  }> = [];

  otherEntities.forEach((entity, sequence) => {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    if (start < 0 || end < start || end > text.length) return;
    events.push({
      position: start,
      eventType: 1,
      lengthSort: -entity.length,
      sequenceSort: sequence,
      sequence,
      entity
    });
    events.push({
      position: end,
      eventType: 0,
      lengthSort: entity.length,
      sequenceSort: -sequence,
      sequence,
      entity
    });
  });

  events.sort(
    (a, b) =>
      a.position - b.position ||
      a.eventType - b.eventType ||
      a.lengthSort - b.lengthSort ||
      a.sequenceSort - b.sequenceSort
  );

  const activeCodeEntities = new Set<number>();
  const parts: string[] = [];
  let previousPosition = 0;
  let eventIndex = 0;
  let previousEventClosedPre = false;

  if (blockquotes.length > 0) {
    if (isExpandableStart(blockquotes, 0)) parts.push("**>");
    else if (blockquoteAt(blockquotes, 0)) parts.push(">");
  }

  while (eventIndex < events.length) {
    const position = events[eventIndex]?.position ?? text.length;

    if (position > previousPosition) {
      emitTextBetween(
        parts,
        text,
        previousPosition,
        position,
        previousEventClosedPre,
        activeCodeEntities.size > 0,
        blockquotes
      );
      previousEventClosedPre = false;
    }

    if (isExpandableEnd(blockquotes, position)) parts.push("||");

    let closedPreAtPosition = false;
    while (eventIndex < events.length && events[eventIndex]?.position === position) {
      const event = events[eventIndex];
      if (!event) break;
      if (event.eventType === 0) {
        activeCodeEntities.delete(event.sequence);
        emitTag(parts, closeTag(event.entity), position, blockquotes);
        if (event.entity.type === "pre") closedPreAtPosition = true;
      } else {
        if (CODE_ENTITY_TYPES.has(event.entity.type)) activeCodeEntities.add(event.sequence);
        emitTag(parts, openTag(event.entity), position, blockquotes);
      }
      eventIndex += 1;
    }

    previousEventClosedPre = closedPreAtPosition;
    previousPosition = position;
  }

  if (previousPosition < text.length) {
    emitTextBetween(
      parts,
      text,
      previousPosition,
      text.length,
      previousEventClosedPre,
      activeCodeEntities.size > 0,
      blockquotes
    );
  }

  if (isExpandableEnd(blockquotes, text.length)) parts.push("||");
  return parts.join("");
}

export function splitMarkdownV2(
  text: string,
  entities: MessageEntity[] = [],
  maxUtf16Len = 4096
): string[] {
  if (maxUtf16Len <= 0) {
    throw new Error("maxUtf16Len must be greater than 0");
  }
  if (!text) return [];

  let pending = splitEntities(text, entities.map(createMessageEntity), maxUtf16Len);
  const chunks: string[] = [];

  while (pending.length > 0) {
    const [chunkText, chunkEntities] = pending.shift() ?? ["", []];
    const rendered = entitiesToMarkdownV2(chunkText, chunkEntities);
    if (utf16Len(rendered) <= maxUtf16Len) {
      chunks.push(rendered);
      continue;
    }

    const plainLength = utf16Len(chunkText);
    if (plainLength <= 1) {
      throw new Error("A single text unit renders longer than maxUtf16Len in MarkdownV2");
    }

    let subLimit = Math.max(1, Math.floor(plainLength / 2));
    let subChunks = splitEntities(chunkText, chunkEntities, subLimit);
    if (subChunks.length === 1) {
      subLimit = Math.max(1, plainLength - 1);
      subChunks = splitEntities(chunkText, chunkEntities, subLimit);
    }
    if (subChunks.length === 1) {
      throw new Error("Unable to split MarkdownV2 output within maxUtf16Len");
    }

    pending = [...subChunks, ...pending];
  }

  return chunks;
}

function escapeWithSet(text: string, chars: Set<string>): string {
  let result = "";
  for (const char of text) {
    if (chars.has(char)) result += "\\";
    result += char;
  }
  return result;
}

function emitTextBetween(
  parts: string[],
  text: string,
  start: number,
  end: number,
  afterPre: boolean,
  inCode: boolean,
  blockquotes: Array<{ start: number; end: number; type: string }>
): void {
  let segment = text.slice(start, end);
  let segmentStart = start;
  if (afterPre && segment.startsWith("\n\n")) {
    segment = segment.slice(1);
    segmentStart += 1;
  }
  if (!segment) return;
  emitSegment(parts, segment, segmentStart, inCode, blockquotes);
}

function emitSegment(
  parts: string[],
  segment: string,
  segmentStart: number,
  inCode: boolean,
  blockquotes: Array<{ start: number; end: number; type: string }>
): void {
  const escapeFn = inCode ? escapeCode : escapeMarkdownV2;
  if (blockquotes.length === 0) {
    parts.push(escapeFn(segment));
    return;
  }

  let lineStart = 0;
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== "\n") continue;
    parts.push(escapeFn(segment.slice(lineStart, index)));
    parts.push("\n");
    const nextPosition = segmentStart + index + 1;
    if (isExpandableStart(blockquotes, nextPosition)) parts.push("**>");
    else if (blockquoteAt(blockquotes, nextPosition)) parts.push(">");
    lineStart = index + 1;
  }

  if (lineStart < segment.length) {
    parts.push(escapeFn(segment.slice(lineStart)));
  }
}

function emitTag(
  parts: string[],
  tag: string,
  position: number,
  blockquotes: Array<{ start: number; end: number; type: string }>
): void {
  if (!tag) return;
  if (blockquotes.length === 0 || !tag.includes("\n")) {
    parts.push(tag);
    return;
  }

  const inQuote = blockquoteAt(blockquotes, position) || (position > 0 && blockquoteAt(blockquotes, position - 1));
  parts.push(inQuote ? tag.replaceAll("\n", "\n>") : tag);
}

function blockquoteAt(
  blockquotes: Array<{ start: number; end: number; type: string }>,
  position: number
): string | undefined {
  return blockquotes.find((range) => range.start <= position && position < range.end)?.type;
}

function isExpandableStart(
  blockquotes: Array<{ start: number; end: number; type: string }>,
  position: number
): boolean {
  return blockquotes.some((range) => range.start === position && range.type === "expandable_blockquote");
}

function isExpandableEnd(
  blockquotes: Array<{ start: number; end: number; type: string }>,
  position: number
): boolean {
  return blockquotes.some((range) => range.end === position && range.type === "expandable_blockquote");
}

function openTag(entity: MessageEntity): string {
  const simple = SIMPLE_MARKERS[entity.type];
  if (simple) return simple[0];
  if (entity.type === "code") return "`";
  if (entity.type === "pre") return entity.language ? `\`\`\`${entity.language}\n` : "```\n";
  if (entity.type === "text_link") return "[";
  if (entity.type === "custom_emoji") return "![";
  if (entity.type === "text_mention") return "[";
  return "";
}

function closeTag(entity: MessageEntity): string {
  const simple = SIMPLE_MARKERS[entity.type];
  if (simple) return simple[1];
  if (entity.type === "code") return "`";
  if (entity.type === "pre") return "\n```";
  if (entity.type === "text_link") return `](${escapeUrl(entity.url || "")})`;
  if (entity.type === "custom_emoji") return `](tg://emoji?id=${entity.custom_emoji_id || ""})`;
  if (entity.type === "text_mention") return "]";
  return "";
}

export const entities_to_markdownv2 = entitiesToMarkdownV2;
export const split_markdownv2 = splitMarkdownV2;
export const _escape_markdownv2 = escapeMarkdownV2;
export const _escape_code = escapeCode;
export const _escape_url = escapeUrl;
