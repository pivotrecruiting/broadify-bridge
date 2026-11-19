const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { mkdtemp, mkdir, rm, writeFile, readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  deriveDeterministicUuid,
  formatUuid,
  patchMachOUuid,
} = require("./lib/macho-uuid.cjs");
const afterPack = require("./patch-macos-main-executable-uuid.cjs");

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;
const LC_MAIN = 0x80000028;
const MH_EXECUTE = 2;

const OLD_UUID_A = Buffer.from("00112233445566778899AABBCCDDEEFF", "hex");
const OLD_UUID_B = Buffer.from("FFEEDDCCBBAA99887766554433221100", "hex");

/**
 * Builds a minimal thin 64-bit Mach-O: header, one dummy load command placed
 * before LC_UUID (so the parser has to walk), optionally the LC_UUID itself,
 * and some trailing "code" bytes that must stay untouched.
 */
function buildThinMachO({ cputype, uuid, includeUuid = true }) {
  const commands = [];

  const main = Buffer.alloc(24);
  main.writeUInt32LE(LC_MAIN, 0);
  main.writeUInt32LE(24, 4);
  main.writeBigUInt64LE(0x1000n, 8);
  main.writeBigUInt64LE(0n, 16);
  commands.push(main);

  if (includeUuid) {
    const lcUuid = Buffer.alloc(24);
    lcUuid.writeUInt32LE(LC_UUID, 0);
    lcUuid.writeUInt32LE(24, 4);
    uuid.copy(lcUuid, 8);
    commands.push(lcUuid);
  }

  const commandBytes = Buffer.concat(commands);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(MH_MAGIC_64, 0);
  header.writeUInt32LE(cputype, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(MH_EXECUTE, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(commandBytes.length, 20);
  header.writeUInt32LE(0, 24);
  header.writeUInt32LE(0, 28);

  const trailer = Buffer.alloc(64, 0xa5);
  return Buffer.concat([header, commandBytes, trailer]);
}

function buildFatMachO(slices, { fat64 = false } = {}) {
  const align = 12;
  const sliceSize = 1 << align;
  const archEntrySize = fat64 ? 32 : 20;
  const header = Buffer.alloc(8 + archEntrySize * slices.length);
  header.writeUInt32BE(fat64 ? FAT_MAGIC_64 : FAT_MAGIC, 0);
  header.writeUInt32BE(slices.length, 4);

  const body = Buffer.alloc(sliceSize * slices.length, 0);
  slices.forEach((slice, index) => {
    const offset = sliceSize * (index + 1);
    const entry = 8 + archEntrySize * index;
    header.writeUInt32BE(slice.cputype, entry);
    header.writeUInt32BE(0, entry + 4);
    if (fat64) {
      header.writeBigUInt64BE(BigInt(offset), entry + 8);
      header.writeBigUInt64BE(BigInt(slice.buffer.length), entry + 16);
      header.writeUInt32BE(align, entry + 24);
      header.writeUInt32BE(0, entry + 28);
    } else {
      header.writeUInt32BE(offset, entry + 8);
      header.writeUInt32BE(slice.buffer.length, entry + 12);
      header.writeUInt32BE(align, entry + 16);
    }
    slice.buffer.copy(body, offset - sliceSize);
  });

  const padded = Buffer.alloc(sliceSize, 0);
  header.copy(padded, 0);
  return Buffer.concat([padded, body]);
}

const NEW_UUID_FOR = {
  [CPU_TYPE_ARM64]: Buffer.from("A0A1A2A3A4A5A6A7A8A9AAABACADAEAF", "hex"),
  [CPU_TYPE_X86_64]: Buffer.from("B0B1B2B3B4B5B6B7B8B9BABBBCBDBEBF", "hex"),
};
const uuidForSlice = (cputype) => {
  const uuid = NEW_UUID_FOR[cputype];
  assert.ok(uuid, `unexpected cputype 0x${cputype.toString(16)}`);
  return uuid;
};

test("patches exactly the 16 LC_UUID bytes of a thin Mach-O-64", () => {
  const original = buildThinMachO({ cputype: CPU_TYPE_ARM64, uuid: OLD_UUID_A });
  const patched = Buffer.from(original);

  const result = patchMachOUuid(patched, uuidForSlice);

  assert.equal(result.slices.length, 1);
  assert.equal(result.slices[0].cputype, CPU_TYPE_ARM64);
  assert.equal(result.slices[0].oldUuid, formatUuid(OLD_UUID_A));
  assert.equal(
    result.slices[0].newUuid,
    formatUuid(NEW_UUID_FOR[CPU_TYPE_ARM64]),
  );

  // LC_MAIN (24 bytes) precedes LC_UUID; its uuid payload sits at 32 + 24 + 8.
  const uuidOffset = 32 + 24 + 8;
  assert.deepEqual(
    patched.subarray(uuidOffset, uuidOffset + 16),
    NEW_UUID_FOR[CPU_TYPE_ARM64],
  );

  const differing = [];
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== patched[index]) {
      differing.push(index);
    }
  }
  assert.equal(patched.length, original.length);
  assert.ok(differing.length > 0);
  assert.ok(
    differing.every((index) => index >= uuidOffset && index < uuidOffset + 16),
    `bytes outside LC_UUID changed: ${differing.join(",")}`,
  );
});

test("patches every slice of a FAT binary with a slice-specific UUID", () => {
  const fat = buildFatMachO([
    {
      cputype: CPU_TYPE_X86_64,
      buffer: buildThinMachO({ cputype: CPU_TYPE_X86_64, uuid: OLD_UUID_B }),
    },
    {
      cputype: CPU_TYPE_ARM64,
      buffer: buildThinMachO({ cputype: CPU_TYPE_ARM64, uuid: OLD_UUID_A }),
    },
  ]);
  const original = Buffer.from(fat);

  const result = patchMachOUuid(fat, uuidForSlice);

  assert.deepEqual(
    result.slices.map((slice) => [slice.cputype, slice.oldUuid, slice.newUuid]),
    [
      [
        CPU_TYPE_X86_64,
        formatUuid(OLD_UUID_B),
        formatUuid(NEW_UUID_FOR[CPU_TYPE_X86_64]),
      ],
      [
        CPU_TYPE_ARM64,
        formatUuid(OLD_UUID_A),
        formatUuid(NEW_UUID_FOR[CPU_TYPE_ARM64]),
      ],
    ],
  );

  const sliceSize = 4096;
  const uuidInSlice = 32 + 24 + 8;
  assert.deepEqual(
    fat.subarray(sliceSize + uuidInSlice, sliceSize + uuidInSlice + 16),
    NEW_UUID_FOR[CPU_TYPE_X86_64],
  );
  assert.deepEqual(
    fat.subarray(2 * sliceSize + uuidInSlice, 2 * sliceSize + uuidInSlice + 16),
    NEW_UUID_FOR[CPU_TYPE_ARM64],
  );

  // The FAT header and everything outside the two UUID payloads is untouched.
  // (Count only the location of differing bytes: a new UUID may share single
  // bytes with the old one, so an exact "32 bytes changed" count is too strict.)
  assert.deepEqual(fat.subarray(0, sliceSize), original.subarray(0, sliceSize));
  const uuidRanges = [1, 2].map((slice) => [
    slice * sliceSize + uuidInSlice,
    slice * sliceSize + uuidInSlice + 16,
  ]);
  const differing = [];
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== fat[index]) {
      differing.push(index);
    }
  }
  assert.equal(fat.length, original.length);
  assert.ok(differing.length > 0);
  assert.ok(
    differing.every((index) =>
      uuidRanges.some(([start, end]) => index >= start && index < end),
    ),
    `bytes outside the LC_UUID payloads changed: ${differing.join(",")}`,
  );
});

test("handles FAT_MAGIC_64 headers", () => {
  const fat = buildFatMachO(
    [
      {
        cputype: CPU_TYPE_ARM64,
        buffer: buildThinMachO({ cputype: CPU_TYPE_ARM64, uuid: OLD_UUID_A }),
      },
    ],
    { fat64: true },
  );

  const result = patchMachOUuid(fat, uuidForSlice);
  assert.equal(result.slices.length, 1);
  assert.equal(
    result.slices[0].newUuid,
    formatUuid(NEW_UUID_FOR[CPU_TYPE_ARM64]),
  );
});

test("throws when a slice has no LC_UUID", () => {
  const buffer = buildThinMachO({
    cputype: CPU_TYPE_ARM64,
    uuid: OLD_UUID_A,
    includeUuid: false,
  });
  assert.throws(() => patchMachOUuid(buffer, uuidForSlice), /LC_UUID/);
});

test("throws on an unknown magic", () => {
  const buffer = Buffer.alloc(64, 0);
  buffer.writeUInt32LE(0x7f454c46, 0); // ELF
  assert.throws(() => patchMachOUuid(buffer, uuidForSlice), /magic/i);
});

test("throws when the UUID callback returns something other than 16 bytes", () => {
  const buffer = buildThinMachO({ cputype: CPU_TYPE_ARM64, uuid: OLD_UUID_A });
  assert.throws(
    () => patchMachOUuid(buffer, () => Buffer.alloc(4)),
    /16 bytes/,
  );
});

test("deriveDeterministicUuid is deterministic and separates Prod from RC", () => {
  const relativePath = "Contents/MacOS/Broadify Bridge";
  const prod = deriveDeterministicUuid({
    appId: "com.broadify.bridge",
    relativePath,
    cputype: CPU_TYPE_ARM64,
  });
  const prodAgain = deriveDeterministicUuid({
    appId: "com.broadify.bridge",
    relativePath,
    cputype: CPU_TYPE_ARM64,
  });
  const rc = deriveDeterministicUuid({
    appId: "com.broadify.bridge.rc",
    relativePath: "Contents/MacOS/Broadify Bridge RC",
    cputype: CPU_TYPE_ARM64,
  });
  const prodIntel = deriveDeterministicUuid({
    appId: "com.broadify.bridge",
    relativePath,
    cputype: CPU_TYPE_X86_64,
  });

  assert.ok(Buffer.isBuffer(prod));
  assert.equal(prod.length, 16);
  assert.deepEqual(prod, prodAgain);
  assert.notDeepEqual(prod, rc);
  assert.notDeepEqual(prod, prodIntel);

  // RFC 4122 version 5 nibble and variant bits.
  for (const uuid of [prod, rc, prodIntel]) {
    assert.equal(uuid[6] >> 4, 0x5);
    assert.equal(uuid[8] & 0xc0, 0x80);
  }
});

test("formatUuid prints the canonical upper-case form dwarfdump uses", () => {
  assert.equal(
    formatUuid(Buffer.from("4c4c44e255553144a1e496ff6d8e37b0", "hex")),
    "4C4C44E2-5555-3144-A1E4-96FF6D8E37B0",
  );
  assert.throws(() => formatUuid(Buffer.alloc(15)), /16 bytes/);
});

test("the CLI prints the expected UUID for a channel", () => {
  const script = path.join(__dirname, "patch-macos-main-executable-uuid.cjs");
  const expected = formatUuid(
    deriveDeterministicUuid({
      appId: "com.broadify.bridge.rc",
      relativePath: "Contents/MacOS/Broadify Bridge RC",
      cputype: CPU_TYPE_X86_64,
    }),
  );
  const output = execFileSync(
    process.execPath,
    [
      script,
      "--print-expected",
      "--app-id",
      "com.broadify.bridge.rc",
      "--product-filename",
      "Broadify Bridge RC",
      "--cputype",
      "x86_64",
    ],
    { encoding: "utf8" },
  );
  assert.equal(output.trim(), expected);

  assert.throws(() =>
    execFileSync(
      process.execPath,
      [script, "--print-expected", "--app-id", "x", "--product-filename", "y"],
      { encoding: "utf8", stdio: "pipe" },
    ),
  );
});

test("afterPack is a no-op outside darwin", async () => {
  const appOutDir = path.join(
    os.tmpdir(),
    `broadify-macho-uuid-missing-${process.pid}-${Date.now()}`,
  );
  // The directory does not exist: any filesystem access would throw.
  await afterPack({
    electronPlatformName: "win32",
    appOutDir,
    packager: {
      appInfo: { id: "com.broadify.bridge", productFilename: "Broadify Bridge" },
    },
  });
  assert.equal(fs.existsSync(appOutDir), false);
});

test("afterPack rewrites the main executable UUID of a darwin bundle", async () => {
  const appOutDir = await mkdtemp(path.join(os.tmpdir(), "broadify-macho-uuid-"));
  try {
    const productFilename = "Broadify Bridge RC";
    const macosDir = path.join(appOutDir, `${productFilename}.app`, "Contents", "MacOS");
    await mkdir(macosDir, { recursive: true });
    const executable = path.join(macosDir, productFilename);
    await writeFile(
      executable,
      buildThinMachO({ cputype: CPU_TYPE_ARM64, uuid: OLD_UUID_A }),
    );

    const result = await afterPack({
      electronPlatformName: "darwin",
      appOutDir,
      packager: {
        appInfo: { id: "com.broadify.bridge.rc", productFilename },
      },
    });

    const expected = deriveDeterministicUuid({
      appId: "com.broadify.bridge.rc",
      relativePath: `Contents/MacOS/${productFilename}`,
      cputype: CPU_TYPE_ARM64,
    });
    const patched = await readFile(executable);
    const uuidOffset = 32 + 24 + 8;
    assert.deepEqual(patched.subarray(uuidOffset, uuidOffset + 16), expected);
    assert.equal(result.slices[0].newUuid, formatUuid(expected));
    assert.equal(result.slices[0].oldUuid, formatUuid(OLD_UUID_A));
  } finally {
    await rm(appOutDir, { recursive: true, force: true });
  }
});

const electronStub = path.join(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);
const hasDwarfdump = (() => {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    execFileSync("xcrun", ["--find", "dwarfdump"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "patched stock Electron launcher reports the expected UUID via dwarfdump",
  {
    skip:
      process.platform !== "darwin"
        ? "macOS only"
        : !hasDwarfdump
          ? "dwarfdump not available"
          : !fs.existsSync(electronStub)
            ? "electron stub not installed"
            : false,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "broadify-macho-uuid-it-"));
    try {
      const copy = path.join(dir, "Electron");
      await writeFile(copy, await readFile(electronStub));

      const buffer = await readFile(copy);
      const result = patchMachOUuid(buffer, (cputype) =>
        deriveDeterministicUuid({
          appId: "com.broadify.bridge.rc",
          relativePath: "Contents/MacOS/Broadify Bridge RC",
          cputype,
        }),
      );
      await writeFile(copy, buffer);

      const output = execFileSync("dwarfdump", ["--uuid", copy], {
        encoding: "utf8",
      });
      const reported = output
        .split("\n")
        .filter((line) => line.startsWith("UUID: "))
        .map((line) => line.split(/\s+/)[1]);
      assert.deepEqual(
        reported.sort(),
        result.slices.map((slice) => slice.newUuid).sort(),
      );
      for (const slice of result.slices) {
        assert.notEqual(slice.oldUuid, slice.newUuid);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
