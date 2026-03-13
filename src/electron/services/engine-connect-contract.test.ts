import { validateEngineConnectInput } from "./engine-connect-contract.js";

describe("validateEngineConnectInput", () => {
  it("returns an error when ip is missing", () => {
    expect(validateEngineConnectInput(undefined, 9910)).toEqual({
      success: false,
      error: "IP address is required",
    });
  });

  it("returns an error when port is missing", () => {
    expect(validateEngineConnectInput("192.168.1.50", undefined)).toEqual({
      success: false,
      error: "Port is required",
    });
  });

  it("builds a fixed atem payload for valid input", () => {
    expect(validateEngineConnectInput("192.168.1.50", 9910)).toEqual({
      success: true,
      body: {
        type: "atem",
        ip: "192.168.1.50",
        port: 9910,
      },
    });
  });
});
