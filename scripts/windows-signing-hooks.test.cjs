const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  serializeWindowsAzureSigning,
} = require("./lib/serialize-windows-azure-signing.cjs");
const {
  resolveWindowsInstallDirectoryName,
} = require("./resolve-windows-install-directory-name.cjs");
const signWindowsNativeResources = require("./sign-windows-native-resources.cjs");

const waitForImmediate = () => new Promise((resolve) => setImmediate(resolve));

test("serializes Azure Trusted Signing calls in their original order", async () => {
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const startedFiles = [];

  class FakeWinPackager {
    constructor() {
      this.platformSpecificBuildOptions = { azureSignOptions: {} };
    }

    async sign(file) {
      startedFiles.push(file);
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await waitForImmediate();
      activeCalls -= 1;
      return true;
    }
  }

  assert.equal(serializeWindowsAzureSigning(FakeWinPackager), true);
  assert.equal(serializeWindowsAzureSigning(FakeWinPackager), false);

  const packager = new FakeWinPackager();
  const results = await Promise.all([
    packager.sign("first.exe"),
    packager.sign("second.dll"),
    packager.sign("third.msi"),
  ]);

  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(startedFiles, ["first.exe", "second.dll", "third.msi"]);
  assert.equal(maximumActiveCalls, 1);
});

test("does not serialize non-Azure signing", async () => {
  let activeCalls = 0;
  let maximumActiveCalls = 0;

  class FakeWinPackager {
    constructor() {
      this.platformSpecificBuildOptions = {};
    }

    async sign() {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await waitForImmediate();
      activeCalls -= 1;
      return true;
    }
  }

  serializeWindowsAzureSigning(FakeWinPackager);
  const packager = new FakeWinPackager();
  await Promise.all([packager.sign("a.exe"), packager.sign("b.exe")]);

  assert.equal(maximumActiveCalls, 2);
});

test("signs exactly the packaged native Windows executables and DLLs", async () => {
  const appOutDir = await mkdtemp(
    path.join(os.tmpdir(), "broadify-windows-signing-"),
  );

  try {
    const expectedFiles =
      signWindowsNativeResources.getWindowsNativeResourcePaths(appOutDir);
    for (const file of expectedFiles) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "test artifact");
    }

    const signedFiles = [];
    await signWindowsNativeResources({
      appOutDir,
      electronPlatformName: "win32",
      packager: {
        platformSpecificBuildOptions: { azureSignOptions: {} },
        async sign(file) {
          signedFiles.push(file);
          return true;
        },
      },
    });

    assert.deepEqual(signedFiles, expectedFiles);
  } finally {
    await rm(appOutDir, { force: true, recursive: true });
  }
});

const repoRoot = path.join(__dirname, "..");
// Normalise CRLF: Windows runners check out with autocrlf.
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");

const FRAMEBUS_ADDON_RESOURCE =
  "resources/bridge/native/framebus/build/Release/framebus.node";

/**
 * Loads electron-builder.config.cjs in a child process with process.platform
 * forced to win32 (the release runner) and returns every packaged
 * extraResources destination (base config plus the Windows-only entries).
 */
function loadWindowsPackagedResourceDestinations() {
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    const config = require(${JSON.stringify(
      path.join(repoRoot, "electron-builder.config.cjs"),
    )});
    process.stdout.write(
      JSON.stringify([
        ...(config.extraResources || []),
        ...((config.win && config.win.extraResources) || []),
      ]),
    );
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).map((entry) =>
    typeof entry === "string" ? entry : entry.to,
  );
}

test("signs the FrameBus Node addon (Smart App Control / WDAC block unsigned DLLs)", () => {
  assert.ok(
    signWindowsNativeResources.WINDOWS_NATIVE_RESOURCES.includes(
      FRAMEBUS_ADDON_RESOURCE,
    ),
    "framebus.node must be in WINDOWS_NATIVE_RESOURCES",
  );
  // The afterSign hook resolves entries relative to appOutDir; the addon must
  // live where the smoke test and the runtime diagnostics expect it.
  assert.match(
    read("scripts/smoke-test-windows-msi.ps1"),
    /resources\\bridge\\native\\framebus\\build\\Release\\framebus\.node/,
  );
  // verify-windows-release-signatures.ps1 only enumerates .exe/.msi files on
  // its own; DLL-like artifacts must be listed explicitly to be verified.
  assert.match(
    read("scripts/verify-windows-release-signatures.ps1"),
    /win-unpacked\\resources\\bridge\\native\\framebus\\build\\Release\\framebus\.node/,
  );
});

test("every signed Windows native resource is packaged by electron-builder", () => {
  const packaged = new Set(
    loadWindowsPackagedResourceDestinations().map((to) => `resources/${to}`),
  );
  for (const resource of signWindowsNativeResources.WINDOWS_NATIVE_RESOURCES) {
    assert.ok(
      packaged.has(resource),
      `${resource} is in the signing list but no extraResources entry packages it`,
    );
  }
});

test("does not run the Windows native signing hook for macOS", async () => {
  let signCalls = 0;

  await signWindowsNativeResources({
    appOutDir: "/path/that/does/not/exist",
    electronPlatformName: "darwin",
    packager: {
      platformSpecificBuildOptions: { azureSignOptions: {} },
      async sign() {
        signCalls += 1;
        return true;
      },
    },
  });

  assert.equal(signCalls, 0);
});

test("loads the serialization patch through the electron-builder CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      path.join(__dirname, "register-windows-azure-signing-serialization.cjs"),
      path.join(__dirname, "../node_modules/electron-builder/cli.js"),
      "--version",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Azure Trusted Signing calls will run sequentially/,
  );
  assert.match(result.stdout, /25\.1\.8/);
});

test("resolves the NSIS install directory from executableName", () => {
  assert.equal(
    resolveWindowsInstallDirectoryName({
      productName: "Broadify Bridge RC",
      win: { executableName: "BroadifyBridgeRC" },
    }),
    "BroadifyBridgeRC",
  );
});

test("falls back to productName and rejects unsafe directory names", () => {
  assert.equal(
    resolveWindowsInstallDirectoryName({
      productName: "Broadify Bridge",
      win: {},
    }),
    "Broadify Bridge",
  );
  assert.throws(
    () =>
      resolveWindowsInstallDirectoryName({
        productName: "Broadify Bridge",
        win: { executableName: "..\\outside" },
      }),
    /safe Windows installation directory name/,
  );
});

test("resolves the RC directory used by the current builder config", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "resolve-windows-install-directory-name.cjs")],
    {
      encoding: "utf8",
      env: { ...process.env, BROADIFY_UPDATER_CHANNEL: "rc" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "BroadifyBridgeRC");
});
