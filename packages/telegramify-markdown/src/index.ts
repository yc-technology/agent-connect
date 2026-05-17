import { convert } from "./converter.js";
import { entitiesToMarkdownV2 } from "./mdv2.js";
import { processMarkdown } from "./pipeline.js";

export { RenderConfig, getRuntimeConfig } from "./config.js";
export {
  ContentType,
  type ContentTrace,
  type File,
  type Photo,
  type TelegramContent,
  type Text
} from "./content.js";
export {
  convert,
  convertWithSegments,
  convert_with_segments,
  type Segment
} from "./converter.js";
export {
  createMessageEntity,
  messageEntityToDict,
  splitEntities,
  utf16Len,
  type MessageEntity
} from "./entity.js";
export {
  _escape_code,
  _escape_markdownv2,
  _escape_url,
  entitiesToMarkdownV2,
  entities_to_markdownv2,
  escapeCode,
  escapeMarkdownV2,
  escapeUrl,
  splitMarkdownV2,
  split_markdownv2
} from "./mdv2.js";
export { processMarkdown, process_markdown } from "./pipeline.js";

export function markdownify(
  content: string,
  options: { latexEscape?: boolean; latex_escape?: boolean } = {}
): string {
  const [text, entities] = convert(content, options);
  return entitiesToMarkdownV2(text, entities);
}

export function standardize(
  content: string,
  options: { latexEscape?: boolean; latex_escape?: boolean } = {}
): string {
  return markdownify(content, options);
}

export async function telegramify(
  content: string,
  options: Parameters<typeof processMarkdown>[1] = {}
) {
  return processMarkdown(content, options);
}

export default function telegramifyMarkdown(
  content: string,
  _mode?: string,
  options: { latexEscape?: boolean; latex_escape?: boolean } = {}
): string {
  return markdownify(content, options);
}
