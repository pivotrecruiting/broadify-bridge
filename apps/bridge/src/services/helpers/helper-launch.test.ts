import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const mockSpawn = jest.fn();
const mockExecFileSync = jest.fn();
let mockOsPlatform: NodeJS.Platform = "darwin";

jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

jest.mock("node:os", () => ({
  ...jest.requireActual("node:os"),
  platform: () => mockOsPlatform,
}));

import { inspectHelperIdentity, launchHelper, resolveControlSocketPath, resolveHelperPath, type HelperSpecT } from "./helper-launch.js";

const SPEC: HelperSpecT = {
  dirName: "pgm-helper",
  binaryName: "pgm-helper",
  pathEnv: "BRIDGE_PGM_HELPER_PATH",
  macosAppName: "Broadify Bridge PGM Helper.app",
  macosExecutableName: "BroadifyPgmHelper",
  socketPrefix: "pgm",
};

describe("launchHelper", () => {
  beforeEach(() => {
    mockSpawn.mockReset().mockReturnValue({ pid: 1 });
    mockExecFileSync.mockReset();
  });

  it("starts the Windows helper directly with windowsHide and without a codesign check", () => {
    mockOsPlatform = "win32";
    const exe = "C:\\Program Files\\Broadify Bridge\\resources\\native\\pgm-helper\\pgm-helper.exe";
    const identity = inspectHelperIdentity(SPEC, exe);
    expect(identity).toEqual({ path: exe, appPath: null, codeSignatureStatus: "not_checked" });
    expect(mockExecFileSync).not.toHaveBeenCalled();
    const env = { BRIDGE_PGM_WINDOWS: "1" };
    expect(launchHelper(identity, ["--run"], env)).toEqual({ child: { pid: 1 }, viaLaunchServices: false });
    expect(mockSpawn).toHaveBeenCalledWith(exe, ["--run"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  });

  it("uses a named pipe as the control socket on Windows", () => {
    mockOsPlatform = "win32";
    expect(resolveControlSocketPath(SPEC)).toMatch(/^\\\\\.\\pipe\\broadify-pgm-\d+-\d+$/);
  });

  it("keeps the Launch Services start on macOS (windowsHide is ignored there)", () => {
    mockOsPlatform = "darwin";
    const appPath = "/Applications/Broadify Bridge.app/Contents/Resources/native/pgm-helper/Broadify Bridge PGM Helper.app";
    const identity = inspectHelperIdentity(SPEC, `${appPath}/Contents/MacOS/BroadifyPgmHelper`);
    expect(identity).toMatchObject({ appPath, codeSignatureStatus: "valid" });
    expect(mockExecFileSync).toHaveBeenCalledWith("/usr/bin/codesign", ["--verify", "--strict", appPath], { stdio: "ignore" });
    const env = {};
    expect(launchHelper(identity, ["--run"], env)).toMatchObject({ viaLaunchServices: true });
    expect(mockSpawn).toHaveBeenCalledWith("/usr/bin/open", ["-W", "-n", appPath, "--args", "--run"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  });
});

/**
 * Where a packaged bridge looks for the helper. The Windows package puts
 * pgm-helper.exe exactly there (scripts/lib/windows-pgm-helper.cjs, behind the
 * build switch BROADIFY_PGM_WINDOWS); the release contract test relies on this
 * lookup instead of pinning source lines.
 */
describe("resolveHelperPath", () => {
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOverride = process.env[SPEC.pathEnv];
  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };

  afterEach(() => {
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, "resourcesPath", resourcesPathDescriptor);
    } else {
      delete (process as unknown as { resourcesPath?: string }).resourcesPath;
    }
    restoreEnv("NODE_ENV", previousNodeEnv);
    restoreEnv(SPEC.pathEnv, previousOverride);
  });

  it("finds the packaged Windows helper under resources/native/<dir>/<binary>.exe", () => {
    mockOsPlatform = "win32";
    const resources = join("install-dir", "resources");
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    process.env.NODE_ENV = "production";
    delete process.env[SPEC.pathEnv];
    expect(resolveHelperPath(SPEC)).toBe(join(resources, "native", "pgm-helper", "pgm-helper.exe"));
  });

  it("lets BRIDGE_PGM_HELPER_PATH point at another helper, also in a packaged bridge", () => {
    mockOsPlatform = "win32";
    Object.defineProperty(process, "resourcesPath", { value: join("install-dir", "resources"), configurable: true });
    process.env.NODE_ENV = "production";
    const override = join("downloads", "pgm-helper.exe");
    process.env[SPEC.pathEnv] = override;
    expect(resolveHelperPath(SPEC)).toBe(override);
  });
});

/**
 * windowsHide is set for every launch through this module. That is only safe
 * while the PGM helper is its sole user: the meeting, display, DeckLink and
 * other helpers start through their own code and must keep their Windows spawn
 * behaviour. Moving another helper here means deciding windowsHide for it.
 */
describe("helper-launch users", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
      }
      return /\.(ts|tsx|js|cjs|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  }

  it("is imported by the PGM helper manager only", () => {
    const root = process.cwd();
    const importers = [join(root, "apps", "bridge", "src"), join(root, "src")]
      .flatMap(sourceFiles)
      .filter((file) => /from\s+["'][^"']*helper-launch(\.js)?["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).split(sep).join("/"));
    expect(importers).toEqual(["apps/bridge/src/services/pgm/pgm-helper-manager.ts"]);
  });
});
