import { EventEmitter } from "node:events";
import { join } from "node:path";

const mockExecFileSync = jest.fn();
const mockSpawn = jest.fn();

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

import {
  DEFAULT_MEETING_FRAMEBUS_NAME,
  getVcamHelperStatus,
  hasEmbeddedVcamSystemExtension,
  isVcamExtensionAvailable,
  openVcamHelperApp,
  resolveVcamHelperAppPath,
  VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME,
  VCAM_EMBEDDED_EXTENSION_REL_PATH,
} from "./vcam-helper.js";

describe("vcam-helper", () => {
  const originalMarker = process.env.BROADIFY_VCAM_EXTENSION_INSTALLED;
  const originalHelperPath = process.env.BRIDGE_VCAM_HELPER_PATH;

  afterEach(() => {
    mockExecFileSync.mockReset();
    mockSpawn.mockReset();
    if (originalMarker === undefined) {
      delete process.env.BROADIFY_VCAM_EXTENSION_INSTALLED;
    } else {
      process.env.BROADIFY_VCAM_EXTENSION_INSTALLED = originalMarker;
    }
    if (originalHelperPath === undefined) {
      delete process.env.BRIDGE_VCAM_HELPER_PATH;
    } else {
      process.env.BRIDGE_VCAM_HELPER_PATH = originalHelperPath;
    }
  });

  it("reports availability when extension marker env is set", () => {
    process.env.BROADIFY_VCAM_EXTENSION_INSTALLED = "1";
    expect(isVcamExtensionAvailable()).toBe(true);
  });

  it("prefers the helper app path env override when it embeds the system extension", () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (!hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    expect(resolveVcamHelperAppPath()).toBe(installed);
  });

  it("ignores helper app paths without an embedded system extension", () => {
    process.env.BRIDGE_VCAM_HELPER_PATH = process.cwd();
    const installed = "/Applications/BroadifyVCam.app";

    if (hasEmbeddedVcamSystemExtension(installed)) {
      expect(resolveVcamHelperAppPath()).toBe(installed);
      return;
    }

    expect(resolveVcamHelperAppPath()).toBeNull();
  });

  it("returns status with the meeting FrameBus name", () => {
    const status = getVcamHelperStatus();

    expect(status.framebusName).toBe(DEFAULT_MEETING_FRAMEBUS_NAME);
    expect(status.backend).toBe("coremediaio_camera_extension");
  });

  it("reports the extension as active when systemextensionsctl shows it enabled", () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (!hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockReturnValueOnce(
      [
        "1 extension(s)",
        "--- com.apple.system_extension.driver_extension",
        "enabled\tactive\tteamID\tbundleID (version)\tname\t[state]",
        "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated enabled]",
      ].join("\n"),
    );

    const status = getVcamHelperStatus();

    expect(status.available).toBe(true);
    expect(status.running).toBe(true);
    expect(status.requiresUserApproval).toBe(false);
    expect(status.code).toBeUndefined();
  });

  it("reports approval required when the extension is listed but not enabled", () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (!hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockReturnValueOnce(
      [
        "1 extension(s)",
        "--- com.apple.system_extension.driver_extension",
        "enabled\tactive\tteamID\tbundleID (version)\tname\t[state]",
        "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]",
      ].join("\n"),
    );

    const status = getVcamHelperStatus();

    expect(status.available).toBe(false);
    expect(status.running).toBe(false);
    expect(status.requiresUserApproval).toBe(true);
    expect(status.code).toBe("user_activation_required");
  });

  it("returns activation requested when the helper app cannot be opened", async () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (!hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockReturnValueOnce(
      [
        "1 extension(s)",
        "--- com.apple.system_extension.driver_extension",
        "enabled\tactive\tteamID\tbundleID (version)\tname\t[state]",
        "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]",
      ].join("\n"),
    );
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: typeof EventEmitter.prototype.once;
        unref: jest.Mock;
      };
      child.unref = jest.fn();
      process.nextTick(() => {
        child.emit("close", 1, null);
      });
      return child;
    });

    const status = await openVcamHelperApp();

    expect(mockSpawn).toHaveBeenCalledWith("open", ["-n", installed], expect.any(Object));
    expect(status.launchRequested).toBe(true);
    expect(status.requiresUserApproval).toBe(true);
    expect(status.code).toBe("activation_requested");
    expect(status.message).toContain("could not be opened automatically");
  });

  it("resolves dev build path when present and valid", () => {
    const candidate = join(
      process.cwd(),
      "apps",
      "bridge",
      "native",
      "vcam-helper",
      "build",
      "Release",
      "BroadifyVCam.app",
    );
    const installed = "/Applications/BroadifyVCam.app";
    if (hasEmbeddedVcamSystemExtension(installed)) {
      expect(resolveVcamHelperAppPath()).toBe(installed);
      return;
    }
    if (!hasEmbeddedVcamSystemExtension(candidate)) {
      expect(resolveVcamHelperAppPath()).toBeNull();
      return;
    }
    expect(resolveVcamHelperAppPath()).toBe(candidate);
  });

  it("exports the embedded system extension bundle path", () => {
    expect(VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME).toBe("com.broadify.vcam.extension.systemextension");
    expect(VCAM_EMBEDDED_EXTENSION_REL_PATH).toContain(VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME);
  });
});
