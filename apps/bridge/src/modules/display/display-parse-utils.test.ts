import {
  sanitizeIdPart,
  normalizeConnectionType,
  normalizeWindowsInstanceKey,
  normalizeWindowsConnectionType,
  parseCsvLine,
  parseCsvRows,
  parseResolution,
  parseRefreshHz,
  parseWindowsMonitorPnpId,
} from "./display-parse-utils.js";

describe("display-parse-utils", () => {
  describe("sanitizeIdPart", () => {
    it("lowercases and replaces non-alphanumeric with dashes", () => {
      expect(sanitizeIdPart("Foo Bar 123")).toBe("foo-bar-123");
    });

    it("strips leading and trailing dashes", () => {
      expect(sanitizeIdPart("--foo--")).toBe("foo");
    });
  });

  describe("normalizeConnectionType", () => {
    it("returns hdmi for hdmi-like strings", () => {
      expect(normalizeConnectionType("HDMI")).toBe("hdmi");
      expect(normalizeConnectionType("Thunderbolt/HDMI")).toBe("hdmi");
    });

    it("returns displayport for displayport-like strings", () => {
      expect(normalizeConnectionType("DisplayPort")).toBe("displayport");
    });

    it("returns thunderbolt for thunderbolt and usb-c", () => {
      expect(normalizeConnectionType("Thunderbolt")).toBe("thunderbolt");
      expect(normalizeConnectionType("USB-C")).toBe("thunderbolt");
    });

    it("returns null for unknown or empty", () => {
      expect(normalizeConnectionType("")).toBeNull();
      expect(normalizeConnectionType(undefined)).toBeNull();
      expect(normalizeConnectionType("VGA")).toBeNull();
    });
  });

  describe("normalizeWindowsInstanceKey", () => {
    it("trims and lowercases", () => {
      expect(normalizeWindowsInstanceKey("  FOO  ")).toBe("foo");
    });

    it("strips trailing _N", () => {
      expect(normalizeWindowsInstanceKey("Monitor_0")).toBe("monitor");
    });
  });

  describe("normalizeWindowsConnectionType", () => {
    it("returns hdmi for values 5 and 6", () => {
      expect(normalizeWindowsConnectionType(5)).toBe("hdmi");
      expect(normalizeWindowsConnectionType(6)).toBe("hdmi");
    });

    it("returns displayport for known values", () => {
      expect(normalizeWindowsConnectionType(10)).toBe("displayport");
      expect(normalizeWindowsConnectionType(18)).toBe("displayport");
    });

    it("returns null for unknown or invalid", () => {
      expect(normalizeWindowsConnectionType(99)).toBeNull();
      expect(normalizeWindowsConnectionType(undefined)).toBeNull();
    });
  });

  describe("parseCsvRows", () => {
    it("parses CSV with header and data rows", () => {
      const csv = "Name,PNPDeviceID,Status\nMonitor1,DISPLAY\\ABC1234,OK\nMonitor2,DISPLAY\\DEF5678,OK";
      const rows = parseCsvRows(csv);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ Name: "Monitor1", PNPDeviceID: "DISPLAY\\ABC1234", Status: "OK" });
      expect(rows[1]).toEqual({ Name: "Monitor2", PNPDeviceID: "DISPLAY\\DEF5678", Status: "OK" });
    });

    it("returns empty array for fewer than 2 lines", () => {
      expect(parseCsvRows("")).toEqual([]);
      expect(parseCsvRows("HeaderOnly")).toEqual([]);
    });
  });

  describe("parseCsvLine", () => {
    it("splits on comma", () => {
      expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
    });

    it("handles quoted fields with comma", () => {
      expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    });

    it("handles escaped quote in quoted field", () => {
      expect(parseCsvLine('"a""b"')).toEqual(['a"b']);
    });
  });

  describe("parseResolution", () => {
    it("parses width x height format", () => {
      expect(parseResolution("1920 x 1080")).toEqual({ width: 1920, height: 1080 });
      expect(parseResolution("3840x2160")).toEqual({ width: 3840, height: 2160 });
    });

    it("returns undefined for invalid", () => {
      expect(parseResolution("invalid")).toBeUndefined();
      expect(parseResolution(undefined)).toBeUndefined();
    });
  });

  describe("parseRefreshHz", () => {
    it("parses Hz suffix", () => {
      expect(parseRefreshHz("60 Hz")).toBe(60);
      expect(parseRefreshHz("59.94 Hz")).toBe(59.94);
    });

    it("returns undefined for invalid", () => {
      expect(parseRefreshHz("no number")).toBeUndefined();
      expect(parseRefreshHz(undefined)).toBeUndefined();
    });
  });

  describe("parseWindowsMonitorPnpId", () => {
    it("extracts vendor and product from DISPLAY format", () => {
      expect(parseWindowsMonitorPnpId("DISPLAY\\ABC1234")).toEqual({
        vendorId: "ABC",
        productId: "1234",
      });
    });

    it("returns empty for invalid format", () => {
      expect(parseWindowsMonitorPnpId("invalid")).toEqual({});
      expect(parseWindowsMonitorPnpId(undefined)).toEqual({});
    });
  });
});
