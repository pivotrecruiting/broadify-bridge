import { commandRouter } from "./command-router.js";

jest.mock("./engine-adapter.js", () => ({
  engineAdapter: {
    getState: jest.fn(() => ({ status: "disconnected", macros: [] })),
    getConnectedSince: jest.fn(() => null),
    getLastError: jest.fn(() => null),
    getMacros: jest.fn(() => []),
    getStatus: jest.fn(() => "disconnected"),
    connect: jest.fn(),
    disconnect: jest.fn(),
    runMacro: jest.fn(),
    stopMacro: jest.fn(),
  },
}));

jest.mock("./device-cache.js", () => ({
  deviceCache: {
    getDevices: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("./bridge-context.js", () => ({
  getBridgeContext: jest.fn(() => ({
    bridgeName: "test-bridge",
    bridgeId: "bridge-1",
    pairingCode: null,
    pairingExpiresAt: null,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })),
}));

jest.mock("./runtime-config.js", () => ({
  runtimeConfig: {
    getConfig: jest.fn(() => null),
    getState: jest.fn(() => "idle"),
    hasOutputs: jest.fn(() => false),
  },
}));

jest.mock("./graphics/graphics-manager.js", () => ({
  graphicsManager: {},
}));

jest.mock("./relay-bridge-identity.js", () => ({
  getRelayBridgeEnrollmentPublicKey: jest.fn().mockResolvedValue("mock-key"),
}));

jest.mock("./runtime-app-version.js", () => ({
  getRuntimeAppVersion: jest.fn(() => "0.1.0"),
}));

describe("command-router", () => {
  describe("handleCommand", () => {
    it("get_status returns running status", async () => {
      const result = await commandRouter.handleCommand("get_status", {});
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        running: true,
        version: "0.1.0",
        bridgeName: "test-bridge",
      });
    });

    it("list_outputs returns output lists from device cache", async () => {
      const { deviceCache } = require("./device-cache.js");
      deviceCache.getDevices.mockResolvedValue([]);

      const result = await commandRouter.handleCommand("list_outputs", {});
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ output1: [], output2: [] });
    });

    it("returns error for unknown command", async () => {
      const result = await commandRouter.handleCommand(
        "unknown_command" as "get_status",
        {}
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown command");
    });
  });
});
