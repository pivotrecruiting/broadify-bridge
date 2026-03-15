import {
  EmptyPayloadSchema,
  PairingCodeSchema,
  ListOutputsSchema,
  EngineConnectSchema,
  MacroIdSchema,
  parseRelayPayload,
} from "./relay-command-schemas.js";

describe("relay-command-schemas", () => {
  describe("EmptyPayloadSchema", () => {
    it("accepts empty object", () => {
      const result = EmptyPayloadSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("rejects object with extra keys", () => {
      const result = EmptyPayloadSchema.safeParse({ foo: "bar" });
      expect(result.success).toBe(false);
    });
  });

  describe("PairingCodeSchema", () => {
    it("accepts valid pairing code", () => {
      const result = PairingCodeSchema.safeParse({
        pairingCode: "ABCD1234",
      });
      expect(result.success).toBe(true);
    });

    it("trims whitespace", () => {
      const result = PairingCodeSchema.safeParse({
        pairingCode: "  ABCD  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pairingCode).toBe("ABCD");
      }
    });

    it("rejects too short code", () => {
      const result = PairingCodeSchema.safeParse({
        pairingCode: "AB",
      });
      expect(result.success).toBe(false);
    });

    it("rejects too long code", () => {
      const result = PairingCodeSchema.safeParse({
        pairingCode: "A".repeat(33),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ListOutputsSchema", () => {
    it("accepts empty object", () => {
      const result = ListOutputsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts optional refresh", () => {
      const result = ListOutputsSchema.safeParse({ refresh: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.refresh).toBe(true);
      }
    });
  });

  describe("EngineConnectSchema", () => {
    it("accepts valid engine config", () => {
      const result = EngineConnectSchema.safeParse({
        type: "atem",
        ip: "10.0.0.1",
        port: 9910,
      });
      expect(result.success).toBe(true);
    });

    it("accepts vmix and tricaster types", () => {
      expect(
        EngineConnectSchema.safeParse({
          type: "vmix",
          ip: "192.168.1.1",
          port: 8088,
        }).success
      ).toBe(true);
      expect(
        EngineConnectSchema.safeParse({
          type: "tricaster",
          ip: "192.168.1.2",
          port: 5951,
        }).success
      ).toBe(true);
    });

    it("rejects invalid ip", () => {
      const result = EngineConnectSchema.safeParse({
        type: "atem",
        ip: "not-an-ip",
        port: 9910,
      });
      expect(result.success).toBe(false);
    });

    it("rejects port out of range", () => {
      const result = EngineConnectSchema.safeParse({
        type: "atem",
        ip: "10.0.0.1",
        port: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("MacroIdSchema", () => {
    it("accepts valid macro id", () => {
      const result = MacroIdSchema.safeParse({ macroId: 42 });
      expect(result.success).toBe(true);
    });

    it("rejects non-integer", () => {
      const result = MacroIdSchema.safeParse({ macroId: 1.5 });
      expect(result.success).toBe(false);
    });
  });

  describe("parseRelayPayload", () => {
    it("returns parsed data when valid", () => {
      const result = parseRelayPayload(
        PairingCodeSchema,
        { pairingCode: "ABCD" },
        "Invalid pairing"
      );
      expect(result).toEqual({ pairingCode: "ABCD" });
    });

    it("throws with custom message when invalid", () => {
      expect(() =>
        parseRelayPayload(PairingCodeSchema, { pairingCode: "AB" }, "Invalid pairing")
      ).toThrow("Invalid pairing");
    });
  });
});
