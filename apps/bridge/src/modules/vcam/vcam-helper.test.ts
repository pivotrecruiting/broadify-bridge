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
  __setVcamActivationPollForTesting,
  DEFAULT_MEETING_FRAMEBUS_NAME,
  getVcamHelperStatus,
  hasEmbeddedVcamSystemExtension,
  isVcamExtensionAvailable,
  openVcamHelperApp,
  resolveVcamHelperAppPath,
  shouldAutoUpgradeEmbeddedVcamApp,
  VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME,
  VCAM_EMBEDDED_EXTENSION_REL_PATH,
} from "./vcam-helper.js";

describe("vcam-helper", () => {
  const originalMarker = process.env.BROADIFY_VCAM_EXTENSION_INSTALLED;
  const originalHelperPath = process.env.BRIDGE_VCAM_HELPER_PATH;

  beforeEach(() => {
    __setVcamActivationPollForTesting(1, 1);
    // Argument-dispatching default: queued mockReturnValueOnce values still
    // serve the first call (systemextensionsctl list), while the quarantine
    // probe added for the App-Translocation fix defaults to "not quarantined"
    // (a missing xattr makes the real binary exit non-zero).
    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (command === "/usr/bin/xattr" && argv[0] === "-p") {
        throw new Error("No such xattr: com.apple.quarantine");
      }
      return "";
    });
  });

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
    // process.cwd() is a real directory but not a valid vcam app bundle, so the
    // override must never be selected. Assert exactly that (rather than null),
    // since other valid fallbacks — e.g. an installed /Applications copy or a
    // local dev build at build/Release/BroadifyVCam.app — may legitimately
    // resolve instead.
    const invalidOverride = process.cwd();
    process.env.BRIDGE_VCAM_HELPER_PATH = invalidOverride;

    expect(resolveVcamHelperAppPath()).not.toBe(invalidOverride);
  });

  it("rejects helper app activation paths outside /Applications", () => {
    process.env.BRIDGE_VCAM_HELPER_PATH = join(
      process.cwd(),
      "apps",
      "bridge",
      "native",
      "vcam-helper",
      "build",
      "Release",
      "BroadifyVCam.app",
    );

    const status = getVcamHelperStatus();

    if (process.platform !== "darwin") {
      expect(status.available).toBe(false);
      expect(status.requiresUserApproval).toBe(false);
      expect(status.code).toBe("platform_not_supported");
      return;
    }

    expect(status.available).toBe(false);
    expect(status.requiresUserApproval).toBe(true);
    expect(status.code).toBe("helper_app_not_in_applications");
    expect(status.message).toContain("/Applications/BroadifyVCam.app");
  });

  it("returns status with the meeting FrameBus name", () => {
    const status = getVcamHelperStatus();

    expect(status.framebusName).toBe(DEFAULT_MEETING_FRAMEBUS_NAME);
    expect(status.backend).toBe("coremediaio_camera_extension");
  });

  it("does not auto-upgrade an installed VCam helper unless explicitly enabled", () => {
    expect(shouldAutoUpgradeEmbeddedVcamApp(13, 12, false)).toBe(false);
    expect(shouldAutoUpgradeEmbeddedVcamApp(13, 12, true)).toBe(true);
    expect(shouldAutoUpgradeEmbeddedVcamApp(12, 12, true)).toBe(false);
    expect(shouldAutoUpgradeEmbeddedVcamApp(null, 12, true)).toBe(false);
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

    expect(mockSpawn).toHaveBeenCalledWith(
      "open",
      [installed, "--args", "--activate"],
      expect.any(Object),
    );
    expect(status.launchRequested).toBe(true);
    expect(status.requiresUserApproval).toBe(true);
    expect(status.code).toBe("activation_requested");
    expect(status.message).toContain("could not be opened automatically");
  });

  it("does not reopen the helper app when the extension is already active", async () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (!hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockReturnValueOnce(
      [
        "1 extension(s)",
        "--- com.apple.system_extension.cmio",
        "enabled\tactive\tteamID\tbundleID (version)\tname\t[state]",
        "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated enabled]",
      ].join("\n"),
    );

    const status = await openVcamHelperApp();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(status.launchRequested).toBe(false);
    expect(status.code).toBe("already_active");
    expect(status.message).toContain("already active");
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

  it("reports helper_app_quarantined when the inactive app carries the quarantine xattr", () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (process.platform !== "darwin" || !hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (command === "systemextensionsctl") {
        return [
          "1 extension(s)",
          "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]",
        ].join("\n");
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-p") {
        return "0081;00000000;Safari;";
      }
      return "";
    });

    const status = getVcamHelperStatus();

    expect(status.available).toBe(false);
    expect(status.requiresUserApproval).toBe(true);
    expect(status.code).toBe("helper_app_quarantined");
    expect(status.message).toContain("App-Translocated");
  });

  it("ignores a leftover quarantine xattr once the extension is active", () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (process.platform !== "darwin" || !hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (command === "systemextensionsctl") {
        return "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated enabled]";
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-p") {
        return "0081;00000000;Safari;";
      }
      return "";
    });

    const status = getVcamHelperStatus();

    expect(status.available).toBe(true);
    expect(status.code).toBeUndefined();
  });

  it("ignores other vendors' activated extensions when classifying our state", () => {
    if (process.platform !== "darwin") {
      return;
    }
    mockExecFileSync.mockImplementation((command: unknown) => {
      if (command === "systemextensionsctl") {
        // Foreign extension active, ours still pending approval.
        return [
          "\t*\tXYZ\tcom.other.vendor.extension (2.0)\tcom.other.vendor.extension\t[activated enabled]",
          "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]",
        ].join("\n");
      }
      throw new Error("No such xattr: com.apple.quarantine");
    });

    expect(isVcamExtensionAvailable()).toBe(false);
  });

  it("auto-upgrades by default and honors the opt-out", () => {
    expect(shouldAutoUpgradeEmbeddedVcamApp(19, 18)).toBe(true);
    expect(shouldAutoUpgradeEmbeddedVcamApp(18, 18)).toBe(false);
    expect(shouldAutoUpgradeEmbeddedVcamApp(19, 18, false)).toBe(false);
  });

  it("reports activation_completed when the extension activates after launch", async () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (process.platform !== "darwin" || !hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    let sysextCalls = 0;
    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (command === "systemextensionsctl") {
        sysextCalls += 1;
        // Pending before launch, activated once the --activate request lands.
        return sysextCalls === 1
          ? "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]"
          : "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated enabled]";
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-p") {
        throw new Error("No such xattr: com.apple.quarantine");
      }
      return "";
    });
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
      (child as { unref: jest.Mock }).unref = jest.fn();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    });

    const result = await openVcamHelperApp();

    expect(result.code).toBe("activation_completed");
    expect(result.requiresUserApproval).toBe(false);
  });

  it("self-heals a quarantined install before opening the helper app", async () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (process.platform !== "darwin" || !hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    let quarantined = true;
    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (command === "systemextensionsctl") {
        return "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]";
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-p") {
        if (!quarantined) {
          throw new Error("No such xattr: com.apple.quarantine");
        }
        return "0081;00000000;Safari;";
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-dr") {
        quarantined = false;
        return "";
      }
      return "";
    });
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
      (child as { unref: jest.Mock }).unref = jest.fn();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    });

    const status = await openVcamHelperApp();

    const xattrStripCall = mockExecFileSync.mock.calls.find(
      ([command, args]) =>
        command === "/usr/bin/xattr" && (args as string[])[0] === "-dr",
    );
    expect(xattrStripCall).toBeDefined();
    expect((xattrStripCall?.[1] as string[])[2]).toBe(installed);
    expect(mockSpawn).toHaveBeenCalledWith(
      "open",
      [installed, "--args", "--activate"],
      expect.any(Object),
    );
    expect(status.code).toBe("activation_requested");
  });

  it("still opens the helper app when the quarantine strip fails", async () => {
    const installed = "/Applications/BroadifyVCam.app";
    if (process.platform !== "darwin" || !hasEmbeddedVcamSystemExtension(installed)) {
      return;
    }

    process.env.BRIDGE_VCAM_HELPER_PATH = installed;
    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (command === "systemextensionsctl") {
        return "\t*\tPG38DC5RG9\tcom.broadify.vcam.extension (1.0)\tcom.broadify.vcam.extension\t[activated waiting for user]";
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-p") {
        return "0081;00000000;Safari;";
      }
      if (command === "/usr/bin/xattr" && argv[0] === "-dr") {
        throw new Error("Operation not permitted");
      }
      return "";
    });
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
      (child as { unref: jest.Mock }).unref = jest.fn();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    });

    const status = await openVcamHelperApp();

    expect(mockSpawn).toHaveBeenCalledWith(
      "open",
      [installed, "--args", "--activate"],
      expect.any(Object),
    );
    expect(status.launchRequested).toBe(true);
  });

  it("strips the quarantine xattr right after installing the embedded app", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    const fs = require("node:fs");
    const resourcesPath = "/tmp/broadify-test-resources";
    const existsSpy = jest
      .spyOn(fs, "existsSync")
      .mockImplementation(
        (target: unknown) => !String(target).startsWith("/Applications/BroadifyVCam.app"),
      );
    Object.defineProperty(process, "resourcesPath", {
      value: resourcesPath,
      configurable: true,
    });
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
      (child as { unref: jest.Mock }).unref = jest.fn();
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    });

    try {
      await openVcamHelperApp();

      const calls = mockExecFileSync.mock.calls;
      const dittoIndex = calls.findIndex(([command]) => command === "/usr/bin/ditto");
      const stripIndex = calls.findIndex(
        ([command, args]) =>
          command === "/usr/bin/xattr" && (args as string[])[0] === "-dr",
      );
      expect(dittoIndex).toBeGreaterThanOrEqual(0);
      expect(stripIndex).toBeGreaterThan(dittoIndex);
      expect((calls[stripIndex][1] as string[])[2]).toBe("/Applications/BroadifyVCam.app");
    } finally {
      existsSpy.mockRestore();
      delete (process as { resourcesPath?: string }).resourcesPath;
    }
  });

  it("exports the embedded system extension bundle path", () => {
    expect(VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME).toBe("com.broadify.vcam.extension.systemextension");
    expect(VCAM_EMBEDDED_EXTENSION_REL_PATH).toContain(VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME);
  });
});
