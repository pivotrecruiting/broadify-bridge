import { validateEngineConnectInput } from "./engine-connect-contract.js";

describe("validateEngineConnectInput", () => {
  it("returns an error when ip is missing", () => {
    expect(validateEngineConnectInput("atem", undefined, 9910)).toEqual({
      success: false,
      error: "IP address is required",
    });
  });

  it("returns an error when port is missing", () => {
    expect(validateEngineConnectInput("atem", "192.168.1.50", undefined)).toEqual({
      success: false,
      error: "Port is required",
    });
  });

  it("builds an atem payload for valid input", () => {
    expect(validateEngineConnectInput("atem", "192.168.1.50", 9910)).toEqual({
      success: true,
      body: {
        type: "atem",
        ip: "192.168.1.50",
        port: 9910,
      },
    });
  });

  it("builds a vmix payload for valid input", () => {
    expect(validateEngineConnectInput("vmix", "127.0.0.1", 8088)).toEqual({
      success: true,
      body: {
        type: "vmix",
        ip: "127.0.0.1",
        port: 8088,
      },
    });
  });
});
