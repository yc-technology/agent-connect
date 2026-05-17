import type { MessageEntity } from "./entity.js";

export const ContentType = {
  TEXT: "text",
  FILE: "file",
  PHOTO: "photo"
} as const;

export type ContentType = (typeof ContentType)[keyof typeof ContentType];

export interface ContentTrace {
  sourceType: string;
  extra?: Record<string, unknown>;
}

export interface Text {
  contentType: typeof ContentType.TEXT;
  text: string;
  entities: MessageEntity[];
  contentTrace: ContentTrace;
}

export interface File {
  contentType: typeof ContentType.FILE;
  fileName: string;
  fileData: Uint8Array;
  contentTrace: ContentTrace;
  captionText: string;
  captionEntities: MessageEntity[];
}

export interface Photo {
  contentType: typeof ContentType.PHOTO;
  fileName: string;
  fileData: Uint8Array;
  contentTrace: ContentTrace;
  captionText: string;
  captionEntities: MessageEntity[];
}

export type TelegramContent = Text | File | Photo;

export function textContent(text: string, entities: MessageEntity[]): Text {
  return {
    contentType: ContentType.TEXT,
    text,
    entities,
    contentTrace: { sourceType: "text" }
  };
}

export function fileContent(
  fileName: string,
  fileData: Uint8Array,
  contentTrace: ContentTrace,
  captionText = "",
  captionEntities: MessageEntity[] = []
): File {
  return {
    contentType: ContentType.FILE,
    fileName,
    fileData,
    contentTrace,
    captionText,
    captionEntities
  };
}
