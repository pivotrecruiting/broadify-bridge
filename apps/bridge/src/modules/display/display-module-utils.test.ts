import {
  buildDisplayMode,
  mapRawDisplaysToDevices,
  type RawDisplayInfoT,
} from "./display-module-utils.js";

describe("display-module-utils", () => {
  describe("buildDisplayMode", () => {
    it("returns mode when resolution and refreshHz present", () => {
      const info: RawDisplayInfoT = {
        name: "External Display",
        connectionType: "hdmi",
        resolution: { width: 1920, height: 1080 },
        refreshHz: 60,
      };
      const modes = buildDisplayMode(info);
      expect(modes).toHaveLength(1);
      expect(modes[0].width).toBe(1920);
      expect(modes[0].height).toBe(1080);
      expect(modes[0].fps).toBe(60);
      expect(modes[0].label).toContain("1080p60");
    });

    it("returns empty array when resolution missing", () => {
      const info: RawDisplayInfoT = {
        name: "Display",
        connectionType: "displayport",
        refreshHz: 60,
      };
      expect(buildDisplayMode(info)).toEqual([]);
    });

    it("returns empty array when refreshHz missing", () => {
      const info: RawDisplayInfoT = {
        name: "Display",
        connectionType: "displayport",
        resolution: { width: 1920, height: 1080 },
      };
      expect(buildDisplayMode(info)).toEqual([]);
    });
  });

  describe("mapRawDisplaysToDevices", () => {
    it("maps raw displays to device descriptors", () => {
      const raw: RawDisplayInfoT[] = [
        {
          name: "LG Monitor",
          connectionType: "hdmi",
          vendorId: "ABC",
          productId: "1234",
          resolution: { width: 1920, height: 1080 },
          refreshHz: 60,
        },
      ];
      const devices = mapRawDisplaysToDevices(raw, { outputRuntimeSupported: true });
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toContain("display-abc-1234");
      expect(devices[0].displayName).toBe("LG Monitor");
      expect(devices[0].type).toBe("display");
      expect(devices[0].ports).toHaveLength(1);
      expect(devices[0].ports[0].type).toBe("hdmi");
      expect(devices[0].status.ready).toBe(true);
    });

    it("uses name fallback when vendor/product missing", () => {
      const raw: RawDisplayInfoT[] = [
        {
          name: "External Display",
          connectionType: "displayport",
        },
      ];
      const devices = mapRawDisplaysToDevices(raw, { outputRuntimeSupported: true });
      expect(devices[0].id).toContain("display-external-display");
    });

    it("sets error when outputRuntimeSupported is false", () => {
      const raw: RawDisplayInfoT[] = [
        {
          name: "Monitor",
          connectionType: "hdmi",
        },
      ];
      const devices = mapRawDisplaysToDevices(raw, { outputRuntimeSupported: false });
      expect(devices[0].status.ready).toBe(false);
      expect(devices[0].status.error).toContain("not implemented");
    });
  });
});
