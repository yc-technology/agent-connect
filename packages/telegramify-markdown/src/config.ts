export class SymbolConfig {
  headingLevel1 = "📌";
  headingLevel2 = "✏️";
  headingLevel3 = "📚";
  headingLevel4 = "🔖";
  headingLevel5 = "";
  headingLevel6 = "";
  image = "🖼";
  link = "🔗";
  taskCompleted = "✅";
  taskUncompleted = "☑️";
  horizontalRule = "————————";
}

export class MermaidConfig {
  theme = "default";
  width = 1000;
  scale = 2;
  imageType = "webp";
}

export class RenderConfig {
  markdownSymbol = new SymbolConfig();
  mermaid = new MermaidConfig();
  citeExpandable = true;
}

const runtimeConfig = new RenderConfig();

export function getRuntimeConfig(): RenderConfig {
  return runtimeConfig;
}
