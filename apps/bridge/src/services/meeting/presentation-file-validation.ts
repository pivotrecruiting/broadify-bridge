import { open, type FileHandle } from "node:fs/promises";

import type { MeetingMediaSourceFormatT } from "./meeting-media-service.js";

const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const REQUIRED_PPTX_ENTRIES = new Set(["[Content_Types].xml", "ppt/presentation.xml"]);

const readExactly = async (file: FileHandle, position: number, length: number): Promise<Buffer> => {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(result, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error("Presentation file ended unexpectedly.");
    }
    offset += bytesRead;
  }
  return result;
};

const findEndOfCentralDirectory = (bytes: Buffer): number => {
  for (
    let offset = bytes.length - ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES;
    offset >= 0;
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  return -1;
};

const containsRequiredPptxEntries = (centralDirectory: Buffer, entryCount: number): boolean => {
  const remainingEntries = new Set(REQUIRED_PPTX_ENTRIES);
  let offset = 0;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (
      offset + 46 > centralDirectory.length ||
      centralDirectory.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_SIGNATURE
    ) {
      return false;
    }

    const flags = centralDirectory.readUInt16LE(offset + 8);
    const fileNameLength = centralDirectory.readUInt16LE(offset + 28);
    const extraLength = centralDirectory.readUInt16LE(offset + 30);
    const commentLength = centralDirectory.readUInt16LE(offset + 32);
    const entryLength = 46 + fileNameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0 || offset + entryLength > centralDirectory.length) {
      return false;
    }

    const fileName = centralDirectory.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    remainingEntries.delete(fileName);
    offset += entryLength;
  }

  return remainingEntries.size === 0;
};

const matchesPptxSignature = async (file: FileHandle, fileSize: number): Promise<boolean> => {
  if (fileSize < ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES) {
    return false;
  }

  const header = await readExactly(file, 0, 4);
  if (header.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
    return false;
  }

  const tailLength = Math.min(
    fileSize,
    ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES + ZIP_MAX_COMMENT_BYTES,
  );
  const tail = await readExactly(file, fileSize - tailLength, tailLength);
  const endOffset = findEndOfCentralDirectory(tail);
  if (endOffset < 0) {
    return false;
  }

  const diskNumber = tail.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = tail.readUInt16LE(endOffset + 6);
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const centralDirectorySize = tail.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entryCount === 0 ||
    centralDirectorySize === 0 ||
    centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES ||
    centralDirectoryOffset + centralDirectorySize > fileSize
  ) {
    return false;
  }

  const centralDirectory = await readExactly(file, centralDirectoryOffset, centralDirectorySize);
  return containsRequiredPptxEntries(centralDirectory, entryCount);
};

export const matchesPresentationFileSignature = async (
  filePath: string,
  sourceFormat: MeetingMediaSourceFormatT,
): Promise<boolean> => {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    if (sourceFormat === "pdf") {
      if (size < PDF_SIGNATURE.length) {
        return false;
      }
      return (await readExactly(file, 0, PDF_SIGNATURE.length)).equals(PDF_SIGNATURE);
    }
    return await matchesPptxSignature(file, size);
  } finally {
    await file.close();
  }
};
