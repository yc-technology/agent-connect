export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string | undefined;
  language?: string | undefined;
  custom_emoji_id?: string | undefined;
}

export function createMessageEntity(init: MessageEntity): MessageEntity {
  const entity: MessageEntity = {
    type: init.type,
    offset: init.offset,
    length: init.length
  };
  if (init.url !== undefined) entity.url = init.url;
  if (init.language !== undefined) entity.language = init.language;
  if (init.custom_emoji_id !== undefined) entity.custom_emoji_id = init.custom_emoji_id;
  return entity;
}

export function messageEntityToDict(entity: MessageEntity): Record<string, string | number> {
  const result: Record<string, string | number> = {
    type: entity.type,
    offset: entity.offset,
    length: entity.length
  };
  if (entity.url !== undefined) result.url = entity.url;
  if (entity.language !== undefined) result.language = entity.language;
  if (entity.custom_emoji_id !== undefined) result.custom_emoji_id = entity.custom_emoji_id;
  return result;
}

export function utf16Len(text: string): number {
  return text.length;
}

export function splitEntities(
  text: string,
  entities: MessageEntity[],
  maxUtf16Len: number
): Array<[string, MessageEntity[]]> {
  if (maxUtf16Len <= 0) {
    throw new Error("maxUtf16Len must be greater than 0");
  }

  if (utf16Len(text) <= maxUtf16Len) {
    return text.trim() ? [[text, entities.map(createMessageEntity)]] : [];
  }

  const splitPoints = findNewlinePositions(text);
  const ranges: Array<[number, number]> = [];
  let start = 0;

  while (start < text.length) {
    const budget = start + maxUtf16Len;
    if (text.length <= budget) {
      ranges.push([start, text.length]);
      break;
    }

    let bestSplit: number | undefined;
    for (const splitPoint of splitPoints) {
      if (splitPoint <= start) continue;
      if (splitPoint <= budget) bestSplit = splitPoint;
      else break;
    }

    if (bestSplit === undefined || bestSplit === start) {
      bestSplit = safeBoundaryAtOrBefore(text, budget);
      if (bestSplit <= start) bestSplit = safeBoundaryAfter(text, start);
    }

    ranges.push([start, bestSplit]);
    start = bestSplit;
  }

  const result: Array<[string, MessageEntity[]]> = [];
  for (const [chunkStart, chunkEnd] of ranges) {
    const chunkText = text.slice(chunkStart, chunkEnd);
    if (!chunkText.trim()) continue;

    const chunkEntities: MessageEntity[] = [];
    for (const entity of entities) {
      const entityStart = entity.offset;
      const entityEnd = entity.offset + entity.length;
      if (entityEnd <= chunkStart || entityStart >= chunkEnd) continue;

      const clippedStart = Math.max(entityStart, chunkStart);
      const clippedEnd = Math.min(entityEnd, chunkEnd);
      if (clippedEnd <= clippedStart) continue;

      chunkEntities.push(
        createMessageEntity({
          ...entity,
          offset: clippedStart - chunkStart,
          length: clippedEnd - clippedStart
        })
      );
    }

    result.push([chunkText, chunkEntities]);
  }

  return result;
}

function findNewlinePositions(text: string): number[] {
  const points: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") points.push(index + 1);
  }
  return points;
}

function safeBoundaryAtOrBefore(text: string, index: number): number {
  let boundary = Math.min(index, text.length);
  while (boundary > 0 && isLowSurrogate(text.charCodeAt(boundary))) {
    boundary -= 1;
  }
  return boundary;
}

function safeBoundaryAfter(text: string, index: number): number {
  const next = Math.min(index + 1, text.length);
  if (next < text.length && isLowSurrogate(text.charCodeAt(next))) {
    return Math.min(next + 1, text.length);
  }
  return next;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
