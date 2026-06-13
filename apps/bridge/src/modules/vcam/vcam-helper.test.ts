import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  isVcamExtensionAvailable,
  resolveVcamHelperAppPath,
} from "./vcam-helper.js";

describe("vcam-helper", () => {
  const originalMarker = process.env.BROADIFY_VCAM_EXTENSION_INSTALLED;

  afterEach(() => {
    if (originalMarker === undefined) {
      delete process.env.BROADIFY_VCAM_EXTENSION_INSTALLED;
    } else {
      process.env.BROADIFY_VCAM_EXTENSION_INSTALLED = originalMarker;
    }
  });

  it("reports availability when extension marker env is set", () => {
    process.env.BROADIFY_VCAM_EXTENSION_INSTALLED = "1";
    expect(isVcamExtensionAvailable()).toBe(true);
  });

  it("resolves dev build path when present", () => {
    const candidate = join(
      process.cwd(),
      "native",
      "vcam-helper",
      "build",
      "Release",
      "BroadifyVCam.app",
    );
    if (!existsSync(candidate)) {
      expect(resolveVcamHelperAppPath()).toBeNull();
      return;
    }
    expect(resolveVcamHelperAppPath()).toBe(candidate);
  });
});
