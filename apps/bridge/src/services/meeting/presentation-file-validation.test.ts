import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { matchesPresentationFileSignature } from "./presentation-file-validation.js";

const createStoredZip = (entryNames: string[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entryName of entryNames) {
    const name = Buffer.from(entryName, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryNames.length, 8);
  end.writeUInt16LE(entryNames.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
};

describe("matchesPresentationFileSignature", () => {
  it("accepts PDF content and rejects renamed text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "broadify-presentation-"));
    const validPath = join(directory, "valid.pdf");
    const invalidPath = join(directory, "invalid.pdf");
    await writeFile(validPath, "%PDF-1.7\ncontent");
    await writeFile(invalidPath, "not a pdf");

    await expect(matchesPresentationFileSignature(validPath, "pdf")).resolves.toBe(true);
    await expect(matchesPresentationFileSignature(invalidPath, "pdf")).resolves.toBe(false);
  });

  it("accepts only ZIPs with the required PPTX entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "broadify-presentation-"));
    const validPath = join(directory, "valid.pptx");
    const invalidPath = join(directory, "invalid.pptx");
    await writeFile(
      validPath,
      createStoredZip(["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]),
    );
    await writeFile(invalidPath, createStoredZip(["[Content_Types].xml", "word/document.xml"]));

    await expect(matchesPresentationFileSignature(validPath, "pptx")).resolves.toBe(true);
    await expect(matchesPresentationFileSignature(invalidPath, "pptx")).resolves.toBe(false);
  });

  it("accepts MP4 (ftyp) and WebM (EBML) video signatures, rejects renamed text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "broadify-presentation-"));
    const mp4Path = join(directory, "clip.mp4");
    const webmPath = join(directory, "clip.webm");
    const fakePath = join(directory, "fake.mp4");
    const mp4Header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from("ftypisom-rest-of-file", "ascii"),
    ]);
    const webmHeader = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(16, 1),
    ]);
    await writeFile(mp4Path, mp4Header);
    await writeFile(webmPath, webmHeader);
    await writeFile(fakePath, "definitely not a video");

    await expect(matchesPresentationFileSignature(mp4Path, "video")).resolves.toBe(true);
    await expect(matchesPresentationFileSignature(webmPath, "video")).resolves.toBe(true);
    await expect(matchesPresentationFileSignature(fakePath, "video")).resolves.toBe(false);
  });
});
