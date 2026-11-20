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

import { inspectHelperIdentity, launchHelper, resolveControlSocketPath, type HelperSpecT } from "./helper-launch.js";

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
