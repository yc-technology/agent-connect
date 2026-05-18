import { EXPANDABLE_QUOTE_END, EXPANDABLE_QUOTE_START } from "./transcriptParser.js";
import { convert as convertTelegramMarkdown, type MessageEntity } from "@yc-tech/telegramify-markdown";

const EXPQUOTE_MAX_RENDERED = 3800;

export function stripSentinels(text: string): string {
  return text.replaceAll(EXPANDABLE_QUOTE_START, "").replaceAll(EXPANDABLE_QUOTE_END, "");
}

export interface TelegramEntityFormattedText {
  text: string;
  entities: MessageEntity[];
}

export function convertMarkdownToTelegramEntities(text: string): TelegramEntityFormattedText {
  const result: TelegramEntityFormattedText = { text: "", entities: [] };
  let offset = 0;

  for (const match of findExpandableQuoteMatches(text)) {
    if (match.start > offset) {
      appendConvertedEntities(result, text.slice(offset, match.start));
    }
    appendExpandableQuoteEntity(result, match.inner);
    offset = match.end;
  }

  if (offset < text.length) {
    appendConvertedEntities(result, text.slice(offset));
  }

  return result;
}

function appendConvertedEntities(result: TelegramEntityFormattedText, text: string): void {
  if (!text) return;
  const leading = text.match(/^\s+/)?.[0] ?? "";
  const trailing = text.match(/\s+$/)?.[0] ?? "";
  const coreEnd = text.length - trailing.length;
  const core = text.slice(leading.length, coreEnd);

  if (leading) result.text += leading;
  if (!core) return;

  const [plainText, entities] = convertTelegramMarkdown(core);
  appendFormatted(result, plainText, entities);
  if (trailing) result.text += trailing;
}

function appendExpandableQuoteEntity(result: TelegramEntityFormattedText, inner: string): void {
  const quoteText = truncateExpandableQuote(inner);
  const offset = result.text.length;
  result.text += quoteText;
  if (quoteText.length > 0) {
    result.entities.push({
      type: "expandable_blockquote",
      offset,
      length: quoteText.length
    });
  }
}

function appendFormatted(result: TelegramEntityFormattedText, text: string, entities: MessageEntity[]): void {
  const offset = result.text.length;
  result.text += text;
  for (const entity of entities) {
    result.entities.push(offsetEntity(entity, offset));
  }
}

function offsetEntity(entity: MessageEntity, offset: number): MessageEntity {
  const shifted: MessageEntity = {
    type: entity.type,
    offset: entity.offset + offset,
    length: entity.length
  };
  if (entity.url !== undefined) shifted.url = entity.url;
  if (entity.language !== undefined) shifted.language = entity.language;
  if (entity.custom_emoji_id !== undefined) shifted.custom_emoji_id = entity.custom_emoji_id;
  return shifted;
}

function truncateExpandableQuote(inner: string): string {
  const suffix = "\n... (truncated)";
  if (inner.length <= EXPQUOTE_MAX_RENDERED) return inner;
  return `${inner.slice(0, EXPQUOTE_MAX_RENDERED - suffix.length)}${suffix}`;
}

function* findExpandableQuoteMatches(text: string): Generator<{ start: number; end: number; inner: string }> {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(EXPANDABLE_QUOTE_START, searchFrom);
    if (start < 0) return;
    const innerStart = start + EXPANDABLE_QUOTE_START.length;
    const endStart = text.indexOf(EXPANDABLE_QUOTE_END, innerStart);
    if (endStart < 0) return;
    yield {
      start,
      end: endStart + EXPANDABLE_QUOTE_END.length,
      inner: text.slice(innerStart, endStart)
    };
    searchFrom = endStart + EXPANDABLE_QUOTE_END.length;
  }
}
