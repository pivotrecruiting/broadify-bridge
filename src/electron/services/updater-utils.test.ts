import { join } from "node:path";
import {
  sanitizeUpdaterErrorMessage,
  parseIntervalMs,
  getUpdaterDisableReason,
  resolveWindowsInstallKind,
  WINDOWS_ELEVATE_HELPER_FILE_NAME,
} from "./updater-utils.js";

describe("updater-utils", () => {
  describe("getUpdaterDisableReason", () => {
    it("returns null when enabled (darwin, packaged)", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "darwin",
          isPackaged: true,
          appImage: undefined,
          windowsInstallKind: null,
        })
      ).toBeNull();
    });

    it("returns reason when BROADIFY_DISABLE_AUTO_UPDATE=1", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: "1",
          platform: "darwin",
          isPackaged: true,
          appImage: undefined,
          windowsInstallKind: null,
        })
      ).toContain("BROADIFY_DISABLE_AUTO_UPDATE");
    });

    it("returns reason when not packaged (dev build)", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "darwin",
          isPackaged: false,
          appImage: undefined,
          windowsInstallKind: null,
        })
      ).toContain("development builds");
    });

    it("returns reason for unsupported platform", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "freebsd",
          isPackaged: true,
          appImage: undefined,
          windowsInstallKind: null,
        })
      ).toContain("Unsupported platform");
    });

    it("returns reason for Linux without AppImage", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "linux",
          isPackaged: true,
          appImage: undefined,
          windowsInstallKind: null,
        })
      ).toContain("AppImage");
    });

    it("returns null for Linux with AppImage", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "linux",
          isPackaged: true,
          appImage: "/path/to/app",
          windowsInstallKind: null,
        })
      ).toBeNull();
    });

    it("disables on win32 when the elevate helper is missing (MSI or portable install)", () => {
      const reason = getUpdaterDisableReason({
        disableEnv: undefined,
        platform: "win32",
        isPackaged: true,
        appImage: undefined,
        windowsInstallKind: "msi_or_portable",
      });
      expect(reason).toContain("MSI");
      expect(reason).toContain(".exe");
    });

    it("stays enabled on win32 for NSIS installs", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "win32",
          isPackaged: true,
          appImage: undefined,
          windowsInstallKind: "nsis",
        })
      ).toBeNull();
    });

    it("ignores the install kind on darwin", () => {
      expect(
        getUpdaterDisableReason({
          disableEnv: undefined,
          platform: "darwin",
          isPackaged: true,
          appImage: undefined,
          windowsInstallKind: "msi_or_portable",
        })
      ).toBeNull();
    });
  });

  describe("resolveWindowsInstallKind", () => {
    it("returns null on darwin without probing the file system", () => {
      const existsSync = jest.fn().mockReturnValue(true);
      expect(
        resolveWindowsInstallKind({
          platform: "darwin",
          resourcesPath: "/Applications/Broadify Bridge.app/Contents/Resources",
          existsSync,
        })
      ).toBeNull();
      expect(existsSync).not.toHaveBeenCalled();
    });

    it("returns null on win32 without a resourcesPath", () => {
      const existsSync = jest.fn().mockReturnValue(true);
      expect(
        resolveWindowsInstallKind({
          platform: "win32",
          resourcesPath: undefined,
          existsSync,
        })
      ).toBeNull();
      expect(existsSync).not.toHaveBeenCalled();
    });

    it("returns nsis when the elevate helper exists next to the resources", () => {
      const resourcesPath = "C:\\Program Files\\Broadify Bridge\\resources";
      const existsSync = jest.fn().mockReturnValue(true);
      expect(
        resolveWindowsInstallKind({ platform: "win32", resourcesPath, existsSync })
      ).toBe("nsis");
      expect(existsSync).toHaveBeenCalledTimes(1);
      expect(existsSync).toHaveBeenCalledWith(
        join(resourcesPath, WINDOWS_ELEVATE_HELPER_FILE_NAME),
      );
      expect(WINDOWS_ELEVATE_HELPER_FILE_NAME).toBe("elevate.exe");
    });

    it("returns msi_or_portable when the elevate helper is missing", () => {
      const resourcesPath = "C:\\Program Files\\Broadify Bridge\\resources";
      const existsSync = jest.fn().mockReturnValue(false);
      expect(
        resolveWindowsInstallKind({ platform: "win32", resourcesPath, existsSync })
      ).toBe("msi_or_portable");
      expect(existsSync).toHaveBeenCalledWith(
        join(resourcesPath, WINDOWS_ELEVATE_HELPER_FILE_NAME),
      );
    });
  });

  describe("sanitizeUpdaterErrorMessage", () => {
    it("redacts bearer tokens", () => {
      expect(
        sanitizeUpdaterErrorMessage("Bearer abc123xyz")
      ).toBe("Bearer [REDACTED]");
    });

    it("redacts authorization headers", () => {
      expect(
        sanitizeUpdaterErrorMessage("Authorization: token secret_key_123")
      ).toBe("Authorization: token [REDACTED]");
    });

    it("redacts GitHub tokens", () => {
      expect(
        sanitizeUpdaterErrorMessage("Error: ghp_abc123def456")
      ).toBe("Error: [REDACTED_GITHUB_TOKEN]");
    });

    it("leaves non-secret messages unchanged", () => {
      expect(sanitizeUpdaterErrorMessage("Network error")).toBe("Network error");
    });
  });

  describe("parseIntervalMs", () => {
    it("returns fallback when value is undefined", () => {
      expect(parseIntervalMs(undefined, 3600000)).toBe(3600000);
    });

    it("returns fallback when value is empty string", () => {
      expect(parseIntervalMs("", 3600000)).toBe(3600000);
    });

    it("parses valid integer", () => {
      expect(parseIntervalMs("60000", 3600000)).toBe(60000);
    });

    it("returns fallback for invalid number", () => {
      expect(parseIntervalMs("abc", 3600000)).toBe(3600000);
    });

    it("returns fallback for zero", () => {
      expect(parseIntervalMs("0", 3600000)).toBe(3600000);
    });

    it("returns fallback for negative", () => {
      expect(parseIntervalMs("-100", 3600000)).toBe(3600000);
    });
  });
});
