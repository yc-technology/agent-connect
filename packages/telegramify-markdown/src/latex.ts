const LATEX_SYMBOLS: Record<string, string> = {
  "\\alpha": "α",
  "\\beta": "β",
  "\\gamma": "γ",
  "\\delta": "δ",
  "\\epsilon": "ε",
  "\\theta": "θ",
  "\\lambda": "λ",
  "\\mu": "μ",
  "\\pi": "π",
  "\\sigma": "σ",
  "\\phi": "φ",
  "\\omega": "ω",
  "\\times": "×",
  "\\cdot": "·",
  "\\le": "≤",
  "\\ge": "≥",
  "\\neq": "≠",
  "\\infty": "∞",
  "\\sum": "∑",
  "\\int": "∫"
};

export function convertLatexToUnicode(input: string): string {
  let output = input;
  for (const [latex, unicode] of Object.entries(LATEX_SYMBOLS)) {
    output = output.replaceAll(latex, unicode);
  }
  output = output.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2");
  output = output.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  output = output.replace(/[{}]/g, "");
  return output;
}

export function containsLatexSymbol(input: string): boolean {
  return /\\(?:frac|sqrt|begin|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|phi|omega|times|cdot|le|ge|neq|infty|sum|int)\b/.test(
    input
  );
}
