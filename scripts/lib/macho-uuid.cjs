// Pure Mach-O LC_UUID helpers used by the macOS afterPack hook. No external
// dependencies: electron-builder hooks run inside the release pipeline where we
// want zero extra install surface.
//
// Background (Apple TN3179): macOS Local Network privacy keys its per-app
// decision on the main executable's LC_UUID. Every electron-builder app that
// renames the stock Electron launcher shares that launcher's UUID, so the Prod
// and RC flavours of Broadify Bridge collided in TCC. We rewrite the UUID with a
// deterministic value derived from appId + path + cputype (never the version),
// so updates keep their identity while Prod and RC stay distinct.
const crypto = require("node:crypto");

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;
const LC_UUID_CMDSIZE = 24;
const MACH_HEADER_64_SIZE = 32;
const FAT_HEADER_SIZE = 8;
const FAT_ARCH_SIZE = 20;
const FAT_ARCH_64_SIZE = 32;

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86_64 = CPU_ARCH_ABI64 | 7;
const CPU_TYPE_ARM64 = CPU_ARCH_ABI64 | 12;

const CPU_TYPE_BY_NAME = Object.freeze({
  arm64: CPU_TYPE_ARM64,
  x86_64: CPU_TYPE_X86_64,
  // electron-builder spells the Intel arch "x64"; accept it for convenience.
  x64: CPU_TYPE_X86_64,
});

/**
 * Resolves a human-readable arch name (arm64, x86_64, x64) to its Mach-O
 * cputype. Numeric input is passed through unchanged.
 */
function resolveCpuType(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  const cputype = CPU_TYPE_BY_NAME[String(value).trim().toLowerCase()];
  if (cputype === undefined) {
    throw new Error(
      `Unknown cputype "${value}" (expected arm64, x86_64 or a numeric Mach-O cputype)`,
    );
  }
  return cputype;
}

/**
 * Derives a stable, flavour-specific UUID (RFC 4122 version 5 layout) from the
 * app id, the executable's bundle-relative path and the slice cputype. The app
 * version is intentionally not part of the input: a changing UUID would reset
 * the user's Local Network decision on every update.
 */
function deriveDeterministicUuid({ appId, relativePath, cputype }) {
  if (typeof appId !== "string" || appId.trim() === "") {
    throw new Error("deriveDeterministicUuid requires a non-empty appId");
  }
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("deriveDeterministicUuid requires a non-empty relativePath");
  }
  const numericCpuType = resolveCpuType(cputype);
  const digest = crypto
    .createHash("sha256")
    .update(`${appId}\0${relativePath}\0${numericCpuType}`, "utf8")
    .digest();
  const uuid = Buffer.from(digest.subarray(0, 16));
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  return uuid;
}

/** Formats 16 UUID bytes the way `dwarfdump --uuid` prints them. */
function formatUuid(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 16) {
    throw new Error("formatUuid expects a Buffer of exactly 16 bytes");
  }
  const hex = buffer.toString("hex").toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function assertBounds(buffer, offset, length, what) {
  if (offset < 0 || offset + length > buffer.length) {
    throw new Error(
      `Mach-O ${what} at offset ${offset} (${length} bytes) exceeds buffer of ${buffer.length} bytes`,
    );
  }
}

/**
 * Patches the LC_UUID of one thin 64-bit little-endian Mach-O slice starting
 * at `sliceOffset`. Returns `{ cputype, oldUuid, newUuid }`.
 */
function patchThinSlice(buffer, sliceOffset, sliceLength, uuidForSlice) {
  assertBounds(buffer, sliceOffset, MACH_HEADER_64_SIZE, "header");
  const magic = buffer.readUInt32LE(sliceOffset);
  if (magic !== MH_MAGIC_64) {
    throw new Error(
      `Unsupported Mach-O magic 0x${magic.toString(16)} at offset ${sliceOffset} (only MH_MAGIC_64 is supported)`,
    );
  }
  const cputype = buffer.readUInt32LE(sliceOffset + 4);
  const ncmds = buffer.readUInt32LE(sliceOffset + 16);
  const sizeofcmds = buffer.readUInt32LE(sliceOffset + 20);
  const commandsStart = sliceOffset + MACH_HEADER_64_SIZE;
  const commandsEnd = commandsStart + sizeofcmds;
  const sliceEnd = sliceOffset + sliceLength;
  if (commandsEnd > sliceEnd) {
    throw new Error(
      `Mach-O load commands (${sizeofcmds} bytes) exceed slice at offset ${sliceOffset}`,
    );
  }

  let offset = commandsStart;
  for (let index = 0; index < ncmds; index += 1) {
    assertBounds(buffer, offset, 8, "load command");
    const cmd = buffer.readUInt32LE(offset);
    const cmdsize = buffer.readUInt32LE(offset + 4);
    if (cmdsize < 8 || offset + cmdsize > commandsEnd) {
      throw new Error(
        `Malformed Mach-O load command #${index} at offset ${offset} (cmdsize ${cmdsize})`,
      );
    }
    if (cmd === LC_UUID) {
      if (cmdsize !== LC_UUID_CMDSIZE) {
        throw new Error(
          `Unexpected LC_UUID cmdsize ${cmdsize} at offset ${offset} (expected ${LC_UUID_CMDSIZE})`,
        );
      }
      const uuidOffset = offset + 8;
      const oldUuid = Buffer.from(buffer.subarray(uuidOffset, uuidOffset + 16));
      const newUuid = uuidForSlice(cputype);
      if (!Buffer.isBuffer(newUuid) || newUuid.length !== 16) {
        throw new Error("uuidForSlice must return a Buffer of exactly 16 bytes");
      }
      newUuid.copy(buffer, uuidOffset);
      return {
        cputype,
        oldUuid: formatUuid(oldUuid),
        newUuid: formatUuid(newUuid),
      };
    }
    offset += cmdsize;
  }

  throw new Error(
    `Mach-O slice at offset ${sliceOffset} (cputype 0x${cputype.toString(16)}) has no LC_UUID load command`,
  );
}

/**
 * Rewrites the LC_UUID of every slice in `buffer` in place. Supports thin
 * 64-bit Mach-O files and FAT (universal) files with 32- or 64-bit arch
 * tables. `uuidForSlice(cputype)` must return the 16-byte UUID for a slice.
 */
function patchMachOUuid(buffer, uuidForSlice) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("patchMachOUuid expects a Buffer");
  }
  if (typeof uuidForSlice !== "function") {
    throw new Error("patchMachOUuid expects a uuidForSlice(cputype) function");
  }
  assertBounds(buffer, 0, 4, "magic");

  const magicBE = buffer.readUInt32BE(0);
  const magicLE = buffer.readUInt32LE(0);

  if (magicLE === MH_MAGIC_64) {
    return { slices: [patchThinSlice(buffer, 0, buffer.length, uuidForSlice)] };
  }

  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const is64 = magicBE === FAT_MAGIC_64;
    const entrySize = is64 ? FAT_ARCH_64_SIZE : FAT_ARCH_SIZE;
    assertBounds(buffer, 0, FAT_HEADER_SIZE, "fat header");
    const nfatArch = buffer.readUInt32BE(4);
    const slices = [];
    for (let index = 0; index < nfatArch; index += 1) {
      const entry = FAT_HEADER_SIZE + entrySize * index;
      assertBounds(buffer, entry, entrySize, "fat_arch");
      let sliceOffset;
      let sliceSize;
      if (is64) {
        sliceOffset = Number(buffer.readBigUInt64BE(entry + 8));
        sliceSize = Number(buffer.readBigUInt64BE(entry + 16));
      } else {
        sliceOffset = buffer.readUInt32BE(entry + 8);
        sliceSize = buffer.readUInt32BE(entry + 12);
      }
      assertBounds(buffer, sliceOffset, sliceSize, `fat slice #${index}`);
      slices.push(patchThinSlice(buffer, sliceOffset, sliceSize, uuidForSlice));
    }
    return { slices };
  }

  throw new Error(
    `Unknown Mach-O magic 0x${magicBE.toString(16)} (not MH_MAGIC_64, FAT_MAGIC or FAT_MAGIC_64)`,
  );
}

module.exports = {
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  LC_UUID,
  MH_MAGIC_64,
  FAT_MAGIC,
  FAT_MAGIC_64,
  deriveDeterministicUuid,
  formatUuid,
  patchMachOUuid,
  resolveCpuType,
};
