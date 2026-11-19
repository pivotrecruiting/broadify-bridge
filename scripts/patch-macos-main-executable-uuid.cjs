// electron-builder afterPack hook (macOS only): give the main executable a
// flavour-specific LC_UUID.
//
// Prod (com.broadify.bridge) and RC (com.broadify.bridge.rc) both rename the
// stock Electron launcher, so without this hook both apps carry Electron's
// LC_UUID. macOS Local Network privacy keys on that UUID (Apple TN3179), which
// made the two apps share one TCC decision and left the RC app with a stale
// Deny rule (ATEM over IP timed out, no prompt). Upstream tracking:
// electron-userland/electron-builder#10297.
//
// afterPack runs before signing in app-builder-lib 25 (platformPackager.js /
// macPackager.js), so the patched binary is covered by codesign + notarization.
// The UUID derives from appId + bundle-relative path + cputype and never from
// the version, so updates keep their identity and only Prod != RC differ.
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  deriveDeterministicUuid,
  formatUuid,
  patchMachOUuid,
  resolveCpuType,
} = require("./lib/macho-uuid.cjs");

const CPU_TYPE_NAMES = Object.freeze({
  [resolveCpuType("arm64")]: "arm64",
  [resolveCpuType("x86_64")]: "x86_64",
});

function mainExecutableRelativePath(productFilename) {
  return `Contents/MacOS/${productFilename}`;
}

function describeCpuType(cputype) {
  return CPU_TYPE_NAMES[cputype] ?? `cputype 0x${cputype.toString(16)}`;
}

/**
 * Returns the UUID string the packaged main executable must carry for a given
 * app id, product filename and arch. Shared by the hook and the CLI used in
 * scripts/verify-macos-release-signing.sh.
 */
function expectedMainExecutableUuid({ appId, productFilename, cputype }) {
  return formatUuid(
    deriveDeterministicUuid({
      appId,
      relativePath: mainExecutableRelativePath(productFilename),
      cputype: resolveCpuType(cputype),
    }),
  );
}

async function patchMacosMainExecutableUuid(context) {
  if (context.electronPlatformName !== "darwin") {
    return undefined;
  }

  const { appInfo } = context.packager;
  // app-builder-lib 25.1.8 AppInfo: `id` is the resolved appId getter and
  // `productFilename` the sanitized executable/bundle name.
  const appId = appInfo.id;
  const productFilename = appInfo.productFilename;
  if (typeof appId !== "string" || appId === "") {
    throw new Error("[MachO] packager.appInfo.id is missing");
  }
  if (typeof productFilename !== "string" || productFilename === "") {
    throw new Error("[MachO] packager.appInfo.productFilename is missing");
  }

  const relativePath = mainExecutableRelativePath(productFilename);
  const executablePath = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    ...relativePath.split("/"),
  );

  const buffer = await readFile(executablePath);
  const result = patchMachOUuid(buffer, (cputype) =>
    deriveDeterministicUuid({ appId, relativePath, cputype }),
  );
  await writeFile(executablePath, buffer);

  for (const slice of result.slices) {
    console.log(
      `[MachO] ${productFilename} LC_UUID ${slice.oldUuid} -> ${slice.newUuid} (${describeCpuType(slice.cputype)})`,
    );
  }
  return result;
}

function parseCliArgs(argv) {
  const options = { printExpected: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--print-expected":
        options.printExpected = true;
        break;
      case "--app-id":
        options.appId = next();
        break;
      case "--product-filename":
        options.productFilename = next();
        break;
      case "--cputype":
        options.cputype = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function runCli(argv) {
  const options = parseCliArgs(argv);
  if (!options.printExpected) {
    throw new Error(
      "Usage: node scripts/patch-macos-main-executable-uuid.cjs --print-expected --app-id <id> --product-filename <name> --cputype <arm64|x86_64>",
    );
  }
  for (const key of ["appId", "productFilename", "cputype"]) {
    if (!options[key]) {
      throw new Error(`--print-expected requires --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  process.stdout.write(`${expectedMainExecutableUuid(options)}\n`);
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[MachO] ${error.message}`);
    process.exit(1);
  }
}

module.exports = patchMacosMainExecutableUuid;
module.exports.afterPack = patchMacosMainExecutableUuid;
module.exports.default = patchMacosMainExecutableUuid;
module.exports.expectedMainExecutableUuid = expectedMainExecutableUuid;
module.exports.mainExecutableRelativePath = mainExecutableRelativePath;
