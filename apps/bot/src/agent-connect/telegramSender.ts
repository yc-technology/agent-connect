export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function splitMessage(
  text: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = "";
  let inCodeBlock = false;
  let codeFence = "";

  for (const line of text.split("\n")) {
    const stripped = line.trim();

    if (stripped.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = stripped;
      } else {
        inCodeBlock = false;
      }
    }

    if (line.length > maxLength) {
      if (currentChunk) {
        let chunkText = currentChunk.replace(/\n+$/g, "");
        if (inCodeBlock) chunkText += "\n```";
        chunks.push(chunkText);
        currentChunk = inCodeBlock ? `${codeFence}\n` : "";
      }
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
    } else if (currentChunk.length + line.length + 1 > maxLength) {
      let chunkText = currentChunk.replace(/\n+$/g, "");
      if (inCodeBlock) chunkText += "\n```";
      chunks.push(chunkText);
      currentChunk = inCodeBlock ? `${codeFence}\n${line}\n` : `${line}\n`;
    } else {
      currentChunk += `${line}\n`;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.replace(/\n+$/g, ""));
  }

  return chunks;
}
