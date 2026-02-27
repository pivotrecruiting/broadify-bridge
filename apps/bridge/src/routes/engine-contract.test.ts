import { EngineErrorCode } from "../services/engine/engine-errors.js";
import {
  ConnectRequestSchema,
  mapEngineErrorToStatusCode,
} from "./engine-contract.js";

describe("ConnectRequestSchema", () => {
  it("accepts valid payload", () => {
    const parsed = ConnectRequestSchema.parse({
      type: "atem",
      ip: "192.168.1.20",
      port: 9910,
    });

    expect(parsed).toEqual({
      type: "atem",
      ip: "192.168.1.20",
      port: 9910,
    });
  });

  it("rejects payload without engine type", () => {
    const result = ConnectRequestSchema.safeParse({
      ip: "192.168.1.20",
      port: 9910,
    });

    expect(result.success).toBe(false);
  });
});

describe("mapEngineErrorToStatusCode", () => {
  it("maps conflict errors to 409", () => {
    expect(mapEngineErrorToStatusCode(EngineErrorCode.ALREADY_CONNECTED)).toBe(
      409,
    );
    expect(mapEngineErrorToStatusCode(EngineErrorCode.ALREADY_CONNECTING)).toBe(
      409,
    );
  });

  it("maps timeout/unreachable errors to 504", () => {
    expect(
      mapEngineErrorToStatusCode(EngineErrorCode.CONNECTION_TIMEOUT),
    ).toBe(504);
    expect(mapEngineErrorToStatusCode(EngineErrorCode.DEVICE_UNREACHABLE)).toBe(
      504,
    );
  });

  it("maps validation errors to 400", () => {
    expect(mapEngineErrorToStatusCode(EngineErrorCode.INVALID_IP)).toBe(400);
    expect(mapEngineErrorToStatusCode(EngineErrorCode.INVALID_PORT)).toBe(400);
  });
});
