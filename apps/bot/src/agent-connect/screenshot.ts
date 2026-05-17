import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

export interface TextStyle {
  fgColor: [number, number, number];
  bgColor: [number, number, number] | null;
}

export interface StyledSegment {
  text: string;
  style: TextStyle;
  fontTier: number;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = findFontsDir(MODULE_DIR);
const FONT_PATHS = [
  join(FONTS_DIR, "JetBrainsMono-Regular.ttf"),
  join(FONTS_DIR, "NotoSansMonoCJKsc-Regular.otf"),
  join(FONTS_DIR, "Symbola.ttf")
];

function findFontsDir(moduleDir: string): string {
  const candidates = [
    join(moduleDir, "fonts"),
    join(moduleDir, "..", "..", "..", "..", "src", "agent-connect", "fonts"),
    join(moduleDir, "..", "..", "..", "..", "..", "src", "agent-connect", "fonts")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

const NOTO_CODEPOINTS = new Set([0x23bf]);
const SYMBOLA_CODEPOINTS = new Set([0x23f5, 0x2714, 0x274c]);

const ANSI_COLORS: Record<number, [number, number, number]> = {
  0: [0, 0, 0],
  1: [205, 49, 49],
  2: [13, 188, 121],
  3: [229, 229, 16],
  4: [36, 114, 200],
  5: [188, 63, 188],
  6: [17, 168, 205],
  7: [229, 229, 229],
  8: [102, 102, 102],
  9: [241, 76, 76],
  10: [35, 209, 139],
  11: [245, 245, 67],
  12: [59, 142, 234],
  13: [214, 112, 214],
  14: [41, 184, 219],
  15: [255, 255, 255]
};

export const DEFAULT_FG: [number, number, number] = [212, 212, 212];
export const DEFAULT_BG: [number, number, number] = [30, 30, 30];

const ANSI_PATTERN = /\x1b\[([0-9;]*)m/g;

export function parseAnsiLine(line: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let currentStyle = defaultStyle();
  let pos = 0;

  for (const match of line.matchAll(ANSI_PATTERN)) {
    const textBefore = line.slice(pos, match.index);
    if (textBefore) {
      for (const [text, tier] of splitLineSegmentsPlain(textBefore)) {
        segments.push({ text, style: currentStyle, fontTier: tier });
      }
    }

    currentStyle = (match[1] ?? "") ? applyAnsiCodes(currentStyle, match[1] ?? "") : defaultStyle();
    pos = match.index + match[0].length;
  }

  const textAfter = line.slice(pos);
  if (textAfter) {
    for (const [text, tier] of splitLineSegmentsPlain(textAfter)) {
      segments.push({ text, style: currentStyle, fontTier: tier });
    }
  }

  return segments.length > 0 ? segments : [{ text: "", style: defaultStyle(), fontTier: 0 }];
}

export async function textToImage(
  text: string,
  options: { fontSize?: number; withAnsi?: boolean } = {}
): Promise<Buffer> {
  const svg = textToSvg(text, options);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function textToSvg(
  text: string,
  options: { fontSize?: number; withAnsi?: boolean } = {}
): string {
  const fontSize = options.fontSize ?? 28;
  const withAnsi = options.withAnsi ?? true;
  const padding = 16;
  const lineHeight = Math.floor(fontSize * 1.4);
  const charWidth = Math.ceil(fontSize * 0.62);
  const lines = text.split("\n");
  const lineSegments = withAnsi
    ? lines.map((line) => parseAnsiLine(line))
    : lines.map((line) =>
        splitLineSegmentsPlain(line).map(([segText, tier]) => ({
          text: segText,
          style: defaultStyle(),
          fontTier: tier
        }))
      );

  const maxUnits = Math.max(
    1,
    ...lineSegments.map((segments) =>
      segments.reduce((sum, segment) => sum + displayUnits(segment.text), 0)
    )
  );
  const width = maxUnits * charWidth + padding * 2;
  const height = Math.max(1, lineSegments.length) * lineHeight + padding * 2;
  const fontCss = buildFontCss();
  const chunks: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    "<style>",
    fontCss,
    `text{font-family:JetBrainsMonoLocal,NotoMonoCjkLocal,SymbolaLocal,Menlo,Consolas,monospace;font-size:${fontSize}px;dominant-baseline:hanging;white-space:pre;}`,
    "</style>",
    "</defs>",
    `<rect width="100%" height="100%" fill="${rgb(DEFAULT_BG)}"/>`
  ];

  let y = padding;
  for (const segments of lineSegments) {
    let x = padding;
    for (const segment of segments) {
      const units = displayUnits(segment.text);
      const segmentWidth = units * charWidth;
      if (segment.style.bgColor) {
        chunks.push(
          `<rect x="${x}" y="${y}" width="${segmentWidth}" height="${lineHeight}" fill="${rgb(segment.style.bgColor)}"/>`
        );
      }
      chunks.push(
        `<text x="${x}" y="${y}" fill="${rgb(segment.style.fgColor)}" xml:space="preserve">${escapeXml(segment.text)}</text>`
      );
      x += segmentWidth;
    }
    y += lineHeight;
  }

  chunks.push("</svg>");
  return chunks.join("");
}

function defaultStyle(): TextStyle {
  return {
    fgColor: DEFAULT_FG,
    bgColor: null
  };
}

function applyAnsiCodes(style: TextStyle, codes: string): TextStyle {
  let next: TextStyle = {
    fgColor: [...style.fgColor] as [number, number, number],
    bgColor: style.bgColor ? ([...style.bgColor] as [number, number, number]) : null
  };
  const parts = codes
    .split(";")
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));

  let i = 0;
  while (i < parts.length) {
    const code = parts[i]!;
    if (code === 0) {
      next = defaultStyle();
    } else if (30 <= code && code <= 37) {
      next.fgColor = ANSI_COLORS[code - 30]!;
    } else if (code === 38) {
      const parsed = parseExtendedColor(parts, i);
      if (parsed) {
        next.fgColor = parsed.color;
        i = parsed.nextIndex;
      }
    } else if (code === 39) {
      next.fgColor = DEFAULT_FG;
    } else if (40 <= code && code <= 47) {
      next.bgColor = ANSI_COLORS[code - 40]!;
    } else if (code === 48) {
      const parsed = parseExtendedColor(parts, i);
      if (parsed) {
        next.bgColor = parsed.color;
        i = parsed.nextIndex;
      }
    } else if (code === 49) {
      next.bgColor = null;
    } else if (90 <= code && code <= 97) {
      next.fgColor = ANSI_COLORS[code - 90 + 8]!;
    } else if (100 <= code && code <= 107) {
      next.bgColor = ANSI_COLORS[code - 100 + 8]!;
    }
    i += 1;
  }

  return next;
}

function parseExtendedColor(
  parts: number[],
  index: number
): { color: [number, number, number]; nextIndex: number } | null {
  if (parts[index + 1] === 5 && parts[index + 2] !== undefined) {
    return { color: approximate256Color(parts[index + 2]! % 256), nextIndex: index + 2 };
  }
  if (
    parts[index + 1] === 2 &&
    parts[index + 2] !== undefined &&
    parts[index + 3] !== undefined &&
    parts[index + 4] !== undefined
  ) {
    return {
      color: [parts[index + 2]!, parts[index + 3]!, parts[index + 4]!],
      nextIndex: index + 4
    };
  }
  return null;
}

export function approximate256Color(index: number): [number, number, number] {
  if (index < 16) return ANSI_COLORS[index]!;
  if (index < 232) {
    const cube = index - 16;
    return [
      Math.floor(cube / 36) * 51,
      (Math.floor(cube / 6) % 6) * 51,
      (cube % 6) * 51
    ];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

function splitLineSegmentsPlain(line: string): Array<[string, number]> {
  if (!line) return [["", 0]];
  const chars = [...line];
  const segments: Array<[string, number]> = [];
  let currentTier = fontTier(chars[0]!);
  let current = "";

  for (const char of chars) {
    const tier = fontTier(char);
    if (tier !== currentTier) {
      segments.push([current, currentTier]);
      current = char;
      currentTier = tier;
    } else {
      current += char;
    }
  }
  segments.push([current, currentTier]);
  return segments;
}

function fontTier(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (SYMBOLA_CODEPOINTS.has(cp)) return 2;
  if (
    NOTO_CODEPOINTS.has(cp) ||
    (cp >= 0x1100 &&
      (cp <= 0x11ff ||
        (0x2e80 <= cp && cp <= 0x9fff) ||
        (0xac00 <= cp && cp <= 0xd7af) ||
        (0xf900 <= cp && cp <= 0xfaff) ||
        (0xfe30 <= cp && cp <= 0xfe4f) ||
        (0xff00 <= cp && cp <= 0xffef) ||
        (0x20000 <= cp && cp <= 0x2fa1f)))
  ) {
    return 1;
  }
  return 0;
}

function displayUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    units += cp >= 0x1100 ? 2 : 1;
  }
  return units;
}

function buildFontCss(): string {
  const names = ["JetBrainsMonoLocal", "NotoMonoCjkLocal", "SymbolaLocal"];
  return FONT_PATHS.map((path, index) => {
    if (!existsSync(path)) return "";
    return `@font-face{font-family:${names[index]};src:url("${pathToFileURL(path).href}");}`;
  }).join("");
}

function rgb(color: [number, number, number]): string {
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
