export function formatTableAsPre(rows: string[][]): string {
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => normalizeTableCell(row[index] || ""))
  );
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(1, ...normalized.map((row) => displayWidth(row[index] || "")))
  );

  const top = border("┌", "┬", "┐", widths);
  const mid = border("├", "┼", "┤", widths);
  const bottom = border("└", "┴", "┘", widths);
  const header = tableLine(normalized[0] || [], widths, "center");
  const body = normalized.slice(1).map((row) => tableLine(row, widths, "left"));
  return [top, header, mid, ...body, bottom].join("\n");
}

function border(left: string, middle: string, right: string, widths: number[]): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function tableLine(row: string[], widths: number[], align: "left" | "center"): string {
  const cells = widths.map((width, index) => {
    const value = row[index] || "";
    const padded = align === "center" ? padCenter(value, width) : padEndDisplay(value, width);
    return ` ${padded} `;
  });
  return `│${cells.join("│")}│`;
}

function padCenter(value: string, width: number): string {
  const remaining = Math.max(0, width - displayWidth(value));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
}

function padEndDisplay(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

function normalizeTableCell(value: string): string {
  return value
    .trim()
    .replace(/^`([^`]+)`$/u, "$1")
    .replace(/^\*\*([\s\S]+)\*\*$/u, "$1")
    .replace(/^\*([\s\S]+)\*$/u, "$1")
    .replace(/^~~([\s\S]+)~~$/u, "$1")
    .replace(/```/g, "'''")
    .replace(/\s+/g, " ");
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isCombiningMark(code)) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

function isCombiningMark(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f);
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}
