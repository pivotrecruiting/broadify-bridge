import {
  EngineConnectPayloadSchema,
  normalizeEngineConnectPayload,
  stripLegacyUsbSentinels,
  toEngineConnectPayload,
} from "./engine-connect-schema.js";

describe("engine-connect-schema", () => {
  it("accepts an IPv4 with surrounding whitespace and returns it trimmed", () => {
    const parsed = EngineConnectPayloadSchema.parse({
      type: "atem",
      ip: " 192.168.1.10 ",
      port: 9910,
    });

    expect(parsed.ip).toBe("192.168.1.10");
    expect(normalizeEngineConnectPayload(parsed)).toMatchObject({
      type: "atem",
      transport: "network",
      ip: "192.168.1.10",
      port: 9910,
    });
  });

  describe("toEngineConnectPayload", () => {
    it("drops the ip/port sentinels for USB", () => {
      const payload = toEngineConnectPayload({
        type: "atem",
        transport: "usb",
        ip: "",
        port: 0,
      });

      expect(payload).toEqual({ type: "atem", transport: "usb" });
      expect("ip" in payload).toBe(false);
      expect("port" in payload).toBe(false);
      expect(EngineConnectPayloadSchema.safeParse(payload).success).toBe(true);
    });

    it("keeps ip/port for network and defaults the transport", () => {
      expect(
        toEngineConnectPayload({
          type: "vmix",
          transport: "network",
          ip: "192.168.1.20",
          port: 8088,
        })
      ).toEqual({
        type: "vmix",
        transport: "network",
        ip: "192.168.1.20",
        port: 8088,
      });
      expect(
        toEngineConnectPayload({ type: "atem", ip: "10.0.0.5", port: 9910 })
      ).toEqual({
        type: "atem",
        transport: "network",
        ip: "10.0.0.5",
        port: 9910,
      });
    });
  });

  describe("stripLegacyUsbSentinels", () => {
    it("removes ip/port from a USB object without mutating the input", () => {
      const raw = { type: "atem", transport: "usb", ip: "", port: 0 };

      const stripped = stripLegacyUsbSentinels(raw);

      expect(stripped).toEqual({ type: "atem", transport: "usb" });
      expect(raw).toEqual({ type: "atem", transport: "usb", ip: "", port: 0 });
      expect(EngineConnectPayloadSchema.safeParse(stripped).success).toBe(true);
    });

    it("leaves network objects untouched", () => {
      const raw = {
        type: "atem",
        transport: "network",
        ip: "192.168.1.10",
        port: 9910,
      };

      expect(stripLegacyUsbSentinels(raw)).toBe(raw);
    });

    it("leaves non-object and transport-less input untouched", () => {
      const noTransport = { type: "atem", ip: "", port: 0 };

      expect(stripLegacyUsbSentinels(null)).toBeNull();
      expect(stripLegacyUsbSentinels("usb")).toBe("usb");
      expect(stripLegacyUsbSentinels(42)).toBe(42);
      expect(stripLegacyUsbSentinels([1, 2])).toEqual([1, 2]);
      expect(stripLegacyUsbSentinels(noTransport)).toBe(noTransport);
    });
  });
});
