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
      expect(EmptyPayloadSchema.parse({})).toEqual({});
    });

    it("rejects object with extra keys", () => {
      expect(() => EmptyPayloadSchema.parse({ foo: 1 })).toThrow();
    });
  });

  describe("PairingCodeSchema", () => {
    it("accepts valid pairing code", () => {
      expect(PairingCodeSchema.parse({ pairingCode: "ABCD1234" })).toEqual({
        pairingCode: "ABCD1234",
      });
    });

    it("rejects code shorter than 4 chars", () => {
      expect(() => PairingCodeSchema.parse({ pairingCode: "AB" })).toThrow();
    });

    it("rejects code longer than 32 chars", () => {
      expect(() =>
        PairingCodeSchema.parse({ pairingCode: "a".repeat(33) })
      ).toThrow();
    });
  });

  describe("ListOutputsSchema", () => {
    it("accepts empty object", () => {
      expect(ListOutputsSchema.parse({})).toEqual({});
    });

    it("accepts refresh boolean", () => {
      expect(ListOutputsSchema.parse({ refresh: true })).toEqual({
        refresh: true,
      });
    });
  });

  describe("EngineConnectSchema", () => {
    it("accepts valid atem config", () => {
      const result = EngineConnectSchema.parse({
        type: "atem",
        ip: "192.168.1.10",
        port: 9910,
      });
      expect(result.type).toBe("atem");
      expect(result.ip).toBe("192.168.1.10");
      expect(result.port).toBe(9910);
    });

    it("rejects invalid IP", () => {
      expect(() =>
        EngineConnectSchema.parse({
          type: "atem",
          ip: "not-an-ip",
          port: 9910,
        })
      ).toThrow();
    });

    it("rejects invalid port", () => {
      expect(() =>
        EngineConnectSchema.parse({
          type: "atem",
          ip: "192.168.1.1",
          port: 99999,
        })
      ).toThrow();
    });
  });

  describe("MacroIdSchema", () => {
    it("accepts valid macroId", () => {
      expect(MacroIdSchema.parse({ macroId: 0 })).toEqual({ macroId: 0 });
      expect(MacroIdSchema.parse({ macroId: 5 })).toEqual({ macroId: 5 });
    });

    it("rejects non-integer macroId", () => {
      expect(() => MacroIdSchema.parse({ macroId: 1.5 })).toThrow();
    });
  });

  describe("parseRelayPayload", () => {
    it("returns parsed data when valid", () => {
      const result = parseRelayPayload(
        PairingCodeSchema,
        { pairingCode: "TEST" },
        "Invalid"
      );
      expect(result).toEqual({ pairingCode: "TEST" });
    });

    it("throws custom error message when invalid", () => {
      expect(() =>
        parseRelayPayload(PairingCodeSchema, { pairingCode: "x" }, "Bad payload")
      ).toThrow("Bad payload");
    });
  });
});
