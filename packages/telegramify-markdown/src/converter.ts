import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { RenderConfig, getRuntimeConfig } from "./config.js";
import { containsLatexSymbol, convertLatexToUnicode } from "./latex.js";
import { formatTableAsPre } from "./table.js";
import { createMessageEntity, type MessageEntity } from "./entity.js";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  url?: string;
  alt?: string | null;
  lang?: string | null;
  checked?: boolean | null;
  ordered?: boolean | null;
  start?: number | null;
  depth?: number;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

export interface Segment {
  kind: "text" | "code_block" | "mermaid";
  textStart: number;
  textEnd: number;
  utf16Start: number;
  utf16End: number;
  language: string;
  rawCode: string;
}

interface EntityScope {
  entityType: string;
  startOffset: number;
  url?: string;
  language?: string;
  custom_emoji_id?: string;
}

class TextBuffer {
  private readonly parts: string[] = [];
  private offset = 0;

  write(text: string): void {
    this.parts.push(text);
    this.offset += text.length;
  }

  get utf16Offset(): number {
    return this.offset;
  }

  get textOffset(): number {
    return this.offset;
  }

  trailingNewlineCount(): number {
    let count = 0;
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index] || "";
      for (let charIndex = part.length - 1; charIndex >= 0; charIndex -= 1) {
        if (part[charIndex] === "\n") count += 1;
        else return count;
      }
    }
    return count;
  }

  popLast(): string {
    const part = this.parts.pop() || "";
    this.offset -= part.length;
    return part;
  }

  getText(): string {
    return this.parts.join("");
  }
}

class EventWalker {
  private readonly buffer = new TextBuffer();
  private readonly entities: MessageEntity[] = [];
  private readonly segments: Segment[] = [];
  private readonly entityStack: EntityScope[] = [];
  private readonly blockquoteScopes: EntityScope[] = [];
  private blockCount = 0;
  private lastBlockEndSource: number | undefined;
  private listStack: Array<number | null> = [];
  private itemIndent = "";

  constructor(
    private readonly config: RenderConfig,
    private readonly sourceMarkdown: string
  ) {}

  walk(root: MdNode): [string, MessageEntity[], Segment[]] {
    for (const child of root.children || []) {
      this.visitBlock(child);
    }

    if (this.config.citeExpandable) {
      for (const entity of this.entities) {
        if (entity.type === "blockquote" && entity.length > 200) {
          entity.type = "expandable_blockquote";
        }
      }
    }

    return [this.buffer.getText(), this.entities, this.segments];
  }

  private visitBlock(node: MdNode): void {
    switch (node.type) {
      case "heading":
        this.visitHeading(node);
        return;
      case "paragraph":
        this.visitParagraph(node);
        return;
      case "code":
        this.visitCodeBlock(node);
        return;
      case "blockquote":
        this.visitBlockquote(node);
        return;
      case "list":
        this.visitList(node);
        return;
      case "thematicBreak":
      case "break":
        this.visitRule(node);
        return;
      case "table":
        this.visitTable(node);
        return;
      case "html":
      case "yaml":
      case "definition":
      case "footnoteDefinition":
        return;
      default:
        for (const child of node.children || []) this.visitBlock(child);
    }
  }

  private visitInline(node: MdNode): void {
    switch (node.type) {
      case "text":
        this.writeTextWithSpoilers(node.value || "");
        return;
      case "strong":
        this.withEntity("bold", () => this.visitInlineChildren(node));
        return;
      case "emphasis":
        this.withEntity("italic", () => this.visitInlineChildren(node));
        return;
      case "delete":
        this.withEntity("strikethrough", () => this.visitInlineChildren(node));
        return;
      case "inlineCode":
        this.writeEntityText("code", node.value || "");
        return;
      case "inlineMath":
        this.writeEntityText("code", normalizeLatex(node.value || ""));
        return;
      case "break":
        this.buffer.write("\n");
        return;
      case "link":
        this.visitLink(node);
        return;
      case "image":
        this.visitImage(node);
        return;
      case "html":
        this.visitInlineHtml(node.value || "");
        return;
      default:
        this.visitInlineChildren(node);
    }
  }

  private visitInlineChildren(node: MdNode): void {
    for (const child of node.children || []) this.visitInline(child);
  }

  private visitHeading(node: MdNode): void {
    this.ensureBlockSpacing(this.sourceStart(node));
    const depth = node.depth || 1;
    const prefix = this.headingPrefix(depth);
    if (prefix) this.buffer.write(`${prefix} `);

    const entityTypes = headingEntities(depth);
    for (const entityType of entityTypes) this.pushEntity(entityType);
    this.visitInlineChildren(node);
    for (const entityType of [...entityTypes].reverse()) this.popEntity(entityType);
    this.markBlockEnd(this.sourceEnd(node));
  }

  private visitParagraph(node: MdNode): void {
    if (this.listStack.length === 0) {
      this.ensureBlockSpacing(this.sourceStart(node));
    }
    this.visitInlineChildren(node);
    if (this.listStack.length === 0) {
      this.markBlockEnd(this.sourceEnd(node));
    } else if (this.buffer.trailingNewlineCount() === 0) {
      this.buffer.write("\n");
    }
  }

  private visitCodeBlock(node: MdNode): void {
    this.ensureBlockSpacing(this.sourceStart(node));
    const rawCode = stripSingleTrailingNewline(node.value || "");
    const language = (node.lang || "").split(",")[0]?.trim() || "";
    const textStart = this.buffer.textOffset;
    const utf16Start = this.buffer.utf16Offset;
    const start = this.buffer.utf16Offset;
    this.buffer.write(rawCode);
    const length = this.buffer.utf16Offset - start;

    if (length > 0) {
      const entity = createMessageEntity({
        type: "pre",
        offset: start,
        length
      });
      if (language) entity.language = language;
      this.entities.push(entity);
    }

    this.segments.push({
      kind: language.toLowerCase() === "mermaid" ? "mermaid" : "code_block",
      textStart,
      textEnd: this.buffer.textOffset,
      utf16Start,
      utf16End: this.buffer.utf16Offset,
      language,
      rawCode
    });

    this.markBlockEnd(this.sourceEnd(node));
  }

  private visitBlockquote(node: MdNode): void {
    this.ensureBlockSpacing(this.sourceStart(node));
    const scope: EntityScope = { entityType: "blockquote", startOffset: this.buffer.utf16Offset };
    this.blockquoteScopes.push(scope);
    for (const child of node.children || []) this.visitBlock(child);
    const current = this.blockquoteScopes.pop();
    if (current) this.finalizeEntity(current);
    this.markBlockEnd(this.sourceEnd(node));
  }

  private visitList(node: MdNode): void {
    if (this.listStack.length === 0) {
      this.ensureBlockSpacing(this.sourceStart(node));
    }
    this.listStack.push(node.ordered ? node.start || 1 : null);
    for (const child of node.children || []) this.visitListItem(child);
    this.listStack.pop();
    if (this.listStack.length === 0) {
      this.markBlockEnd(this.sourceEnd(node));
    }
  }

  private visitListItem(node: MdNode): void {
    const depth = this.listStack.length;
    const indent = depth > 1 ? "  ".repeat(depth - 1) : "";
    const currentList = this.listStack[this.listStack.length - 1] ?? null;

    if (this.buffer.textOffset > 0 && this.buffer.trailingNewlineCount() === 0) {
      this.buffer.write("\n");
    }

    this.itemIndent = indent;
    if (node.checked === true) {
      this.buffer.write(`${indent}${this.config.markdownSymbol.taskCompleted} `);
    } else if (node.checked === false) {
      this.buffer.write(`${indent}${this.config.markdownSymbol.taskUncompleted} `);
    } else if (currentList !== null) {
      this.buffer.write(`${indent}${currentList}. `);
      this.listStack[this.listStack.length - 1] = currentList + 1;
    } else {
      this.buffer.write(`${indent}⦁ `);
    }

    for (const child of node.children || []) {
      if (child.type === "paragraph") this.visitInlineChildren(child);
      else this.visitBlock(child);
    }

    if (this.buffer.trailingNewlineCount() === 0) this.buffer.write("\n");
  }

  private visitRule(node: MdNode): void {
    this.ensureBlockSpacing(this.sourceStart(node));
    this.buffer.write(this.config.markdownSymbol.horizontalRule);
    this.markBlockEnd(this.sourceEnd(node));
  }

  private visitTable(node: MdNode): void {
    this.ensureBlockSpacing(this.sourceStart(node));
    const rows = (node.children || []).map((row) =>
      (row.children || []).map((cell) => this.inlinePlainText(cell.children || []))
    );
    const tableText = formatTableAsPre(rows);
    const start = this.buffer.utf16Offset;
    this.buffer.write(tableText);
    const length = this.buffer.utf16Offset - start;
    if (length > 0) {
      this.entities.push(createMessageEntity({ type: "pre", offset: start, length }));
    }
    this.markBlockEnd(this.sourceEnd(node));
  }

  private visitLink(node: MdNode): void {
    const url = node.url || "";
    const emojiId = validateTelegramEmoji(url);
    if (emojiId) {
      this.withEntity("custom_emoji", () => this.visitInlineChildren(node), { custom_emoji_id: emojiId });
    } else if (url) {
      this.withEntity("text_link", () => this.visitInlineChildren(node), { url });
    } else {
      this.visitInlineChildren(node);
    }
  }

  private visitImage(node: MdNode): void {
    const url = node.url || "";
    const emojiId = validateTelegramEmoji(url);
    if (emojiId) {
      this.writeEntityText("custom_emoji", node.alt || "😀", { custom_emoji_id: emojiId });
      return;
    }
    const start = this.buffer.utf16Offset;
    this.buffer.write(this.config.markdownSymbol.image);
    const length = this.buffer.utf16Offset - start;
    if (length > 0 && url) {
      this.entities.push(createMessageEntity({ type: "text_link", offset: start, length, url }));
    }
  }

  private visitInlineHtml(value: string): void {
    const tag = value.trim().toLowerCase();
    if (tag === "<tg-spoiler>") this.pushEntity("spoiler");
    else if (tag === "</tg-spoiler>") this.popEntity("spoiler");
  }

  private writeTextWithSpoilers(text: string): void {
    let index = 0;
    while (index < text.length) {
      const start = findUnescaped(text, "||", index);
      if (start < 0) {
        this.buffer.write(text.slice(index));
        return;
      }
      const end = findUnescaped(text, "||", start + 2);
      if (end < 0) {
        this.buffer.write(text.slice(index));
        return;
      }
      this.buffer.write(text.slice(index, start));
      this.writeEntityText("spoiler", text.slice(start + 2, end));
      index = end + 2;
    }
  }

  private writeEntityText(entityType: string, text: string, extra: Partial<EntityScope> = {}): void {
    const start = this.buffer.utf16Offset;
    this.buffer.write(text);
    const length = this.buffer.utf16Offset - start;
    if (length > 0) {
      this.entities.push(
        createMessageEntity({
          type: entityType,
          offset: start,
          length,
          url: extra.url,
          language: extra.language,
          custom_emoji_id: extra.custom_emoji_id
        })
      );
    }
  }

  private withEntity(entityType: string, fn: () => void, extra: Partial<EntityScope> = {}): void {
    this.pushEntity(entityType, extra);
    fn();
    this.popEntity(entityType);
  }

  private pushEntity(entityType: string, extra: Partial<EntityScope> = {}): void {
    const scope: EntityScope = {
      entityType,
      startOffset: this.buffer.utf16Offset
    };
    if (extra.url !== undefined) scope.url = extra.url;
    if (extra.language !== undefined) scope.language = extra.language;
    if (extra.custom_emoji_id !== undefined) scope.custom_emoji_id = extra.custom_emoji_id;
    this.entityStack.push(scope);
  }

  private popEntity(entityType: string): void {
    for (let index = this.entityStack.length - 1; index >= 0; index -= 1) {
      const scope = this.entityStack[index];
      if (!scope || scope.entityType !== entityType) continue;
      this.entityStack.splice(index, 1);
      this.finalizeEntity(scope);
      return;
    }
  }

  private finalizeEntity(scope: EntityScope): void {
    const length = this.buffer.utf16Offset - scope.startOffset;
    if (length <= 0) return;
    this.entities.push(
      createMessageEntity({
        type: scope.entityType,
        offset: scope.startOffset,
        length,
        url: scope.url,
        language: scope.language,
        custom_emoji_id: scope.custom_emoji_id
      })
    );
  }

  private headingPrefix(depth: number): string {
    const symbols = this.config.markdownSymbol;
    if (depth === 1) return symbols.headingLevel1;
    if (depth === 2) return symbols.headingLevel2;
    if (depth === 3) return symbols.headingLevel3;
    if (depth === 4) return symbols.headingLevel4;
    if (depth === 5) return symbols.headingLevel5;
    return symbols.headingLevel6;
  }

  private inlinePlainText(nodes: MdNode[]): string {
    let result = "";
    const append = (node: MdNode): void => {
      switch (node.type) {
        case "text":
        case "inlineCode":
        case "inlineMath":
          result += node.value || "";
          return;
        case "break":
          result += " ";
          return;
        case "image":
          result += node.alt || this.config.markdownSymbol.image;
          return;
        default:
          for (const child of node.children || []) append(child);
      }
    };
    for (const node of nodes) append(node);
    return result;
  }

  private ensureBlockSpacing(nextBlockStart: number | undefined): void {
    if (this.blockCount <= 0) return;
    const desired =
      nextBlockStart === undefined || this.hasExtraBlankLine(nextBlockStart) ? 2 : 1;
    const needed = desired - this.buffer.trailingNewlineCount();
    if (needed > 0) this.buffer.write("\n".repeat(needed));
  }

  private markBlockEnd(sourceEnd: number | undefined): void {
    this.blockCount += 1;
    if (sourceEnd !== undefined) this.lastBlockEndSource = sourceEnd;
  }

  private hasExtraBlankLine(nextBlockStart: number): boolean {
    if (this.lastBlockEndSource === undefined || nextBlockStart <= this.lastBlockEndSource) {
      return false;
    }
    return /[\r\n]/.test(this.sourceMarkdown.slice(this.lastBlockEndSource, nextBlockStart));
  }

  private sourceStart(node: MdNode): number | undefined {
    return node.position?.start?.offset;
  }

  private sourceEnd(node: MdNode): number | undefined {
    return node.position?.end?.offset;
  }
}

export function convert(
  markdown: string,
  options: { latex_escape?: boolean; latexEscape?: boolean; config?: RenderConfig } = {}
): [string, MessageEntity[]] {
  const [text, entities] = convertWithSegments(markdown, options);
  return [text, entities];
}

export function convertWithSegments(
  markdown: string,
  options: { latex_escape?: boolean; latexEscape?: boolean; config?: RenderConfig } = {}
): [string, MessageEntity[], Segment[]] {
  const config = options.config || getRuntimeConfig();
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as MdNode;
  const walker = new EventWalker(config, markdown);
  return walker.walk(tree);
}

function headingEntities(depth: number): string[] {
  if (depth <= 2) return ["bold", "underline"];
  if (depth <= 4) return ["bold"];
  return ["italic"];
}

function validateTelegramEmoji(url: string): string | undefined {
  const prefix = "tg://emoji?id=";
  if (!url.startsWith(prefix)) return undefined;
  const id = url.slice(prefix.length);
  return /^\d{19}$/.test(id) ? id : undefined;
}

function stripSingleTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function normalizeLatex(value: string): string {
  return containsLatexSymbol(value) ? convertLatexToUnicode(value).trim() : value;
}

function findUnescaped(text: string, needle: string, fromIndex: number): number {
  let index = text.indexOf(needle, fromIndex);
  while (index >= 0) {
    if (index === 0 || text[index - 1] !== "\\") return index;
    index = text.indexOf(needle, index + needle.length);
  }
  return -1;
}

export const convert_with_segments = convertWithSegments;
