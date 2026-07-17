const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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
