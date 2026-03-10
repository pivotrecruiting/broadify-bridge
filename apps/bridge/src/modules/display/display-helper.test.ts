import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDisplayHelperPath } from "./display-helper.js";

type ProcessWithResourcesPathT = NodeJS.Process & {
  resourcesPath?: string;
};

const processWithResourcesPath = process as ProcessWithResourcesPathT;
const originalCwd = process.cwd();
const originalNodeEnv = process.env.NODE_ENV;
const originalHelperPath = process.env.BRIDGE_DISPLAY_HELPER_PATH;
const originalResourcesPath = processWithResourcesPath.resourcesPath;

const setResourcesPath = (value: string | undefined): void => {
  Object.defineProperty(processWithResourcesPath, "resourcesPath", {
    value,
    configurable: true,
  });
};

describe("resolveDisplayHelperPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "display-helper-test-"));
    delete process.env.BRIDGE_DISPLAY_HELPER_PATH;
    delete process.env.NODE_ENV;
    setResourcesPath(originalResourcesPath);
    process.chdir(originalCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.NODE_ENV = originalNodeEnv;
    if (originalHelperPath) {
      process.env.BRIDGE_DISPLAY_HELPER_PATH = originalHelperPath;
    } else {
      delete process.env.BRIDGE_DISPLAY_HELPER_PATH;
    }
    setResourcesPath(originalResourcesPath);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prefers the explicit environment override", () => {
    process.env.BRIDGE_DISPLAY_HELPER_PATH = "/tmp/custom-display-helper";

    expect(resolveDisplayHelperPath()).toBe("/tmp/custom-display-helper");
  });

  it("uses packaged resources path in production", () => {
    process.env.NODE_ENV = "production";
    setResourcesPath("/Applications/Broadify Bridge.app/Contents/Resources");

    expect(resolveDisplayHelperPath()).toBe(
      path.join(
        "/Applications/Broadify Bridge.app/Contents/Resources",
        "native",
        "display-helper",
        "display-helper"
      )
    );
  });

  it("falls back to cwd-based helper path in development", () => {
    process.chdir(tempDir);
    process.env.NODE_ENV = "development";

    expect(resolveDisplayHelperPath()).toBe(
      path.join(process.cwd(), "native", "display-helper", "display-helper")
    );
  });
});
