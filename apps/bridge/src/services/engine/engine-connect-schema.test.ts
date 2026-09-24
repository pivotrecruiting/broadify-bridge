import {
  EngineConnectPayloadSchema,
  normalizeEngineConnectPayload,
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
});
