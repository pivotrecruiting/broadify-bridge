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
  graphicsManager: {
    configureOutputs: jest.fn().mockResolvedValue(undefined),
    sendLayer: jest.fn().mockResolvedValue(undefined),
    sendTestPattern: jest.fn().mockResolvedValue(undefined),
    updateValues: jest.fn().mockResolvedValue(undefined),
    updateLayout: jest.fn().mockResolvedValue(undefined),
    removeLayer: jest.fn().mockResolvedValue(undefined),
    removePreset: jest.fn().mockResolvedValue(undefined),
    initialize: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn(() => ({ outputConfig: null, activePreset: null, activePresets: [] })),
  },
}));

jest.mock("./relay-bridge-identity.js", () => ({
  getRelayBridgeEnrollmentPublicKey: jest.fn().mockResolvedValue("mock-key"),
}));

jest.mock("./runtime-app-version.js", () => ({
  getRuntimeAppVersion: jest.fn(() => "0.1.0"),
}));

const defaultBridgeContext = {
  bridgeName: "test-bridge",
  bridgeId: "bridge-1",
  pairingCode: null,
  pairingExpiresAt: null,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

describe("command-router", () => {
  beforeEach(() => {
    const { getBridgeContext } = require("./bridge-context.js");
    getBridgeContext.mockReturnValue(defaultBridgeContext);
  });

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
      expect(deviceCache.getDevices).toHaveBeenCalledWith(false);
    });

    it("list_outputs passes refresh to device cache when requested", async () => {
      const { deviceCache } = require("./device-cache.js");
      deviceCache.getDevices.mockResolvedValue([]);

      await commandRouter.handleCommand("list_outputs", { refresh: true });
      expect(deviceCache.getDevices).toHaveBeenCalledWith(true);
    });

    it("returns error for unknown command", async () => {
      const result = await commandRouter.handleCommand(
        "unknown_command" as "get_status",
        {}
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown command");
    });

    it("engine_get_status returns state with connectedSince and lastError", async () => {
      const { engineAdapter } = require("./engine-adapter.js");
      engineAdapter.getState.mockReturnValue({
        status: "connected",
        type: "atem",
        macros: [],
      });
      engineAdapter.getConnectedSince.mockReturnValue(1234567890);
      engineAdapter.getLastError.mockReturnValue(null);

      const result = await commandRouter.handleCommand("engine_get_status", {});
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        state: expect.objectContaining({
          status: "connected",
          type: "atem",
          connectedSince: 1234567890,
        }),
      });
    });

    it("engine_get_macros returns error when not connected", async () => {
      const { engineAdapter } = require("./engine-adapter.js");
      engineAdapter.getStatus.mockReturnValue("disconnected");
      engineAdapter.getMacros.mockReturnValue([]);

      const result = await commandRouter.handleCommand("engine_get_macros", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Engine not connected");
      expect(result.data).toMatchObject({ macros: [] });
    });

    it("engine_get_macros returns macros when connected", async () => {
      const { engineAdapter } = require("./engine-adapter.js");
      engineAdapter.getStatus.mockReturnValue("connected");
      engineAdapter.getMacros.mockReturnValue([
        { id: 1, name: "Macro 1", status: "idle" },
      ]);

      const result = await commandRouter.handleCommand("engine_get_macros", {});
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        macros: [{ id: 1, name: "Macro 1", status: "idle" }],
      });
    });

    it("engine_connect returns state after connect", async () => {
      const { engineAdapter } = require("./engine-adapter.js");
      engineAdapter.getState.mockReturnValue({
        status: "connected",
        type: "atem",
        macros: [],
      });

      const result = await commandRouter.handleCommand("engine_connect", {
        type: "atem",
        ip: "192.168.1.10",
        port: 9910,
      });
      expect(result.success).toBe(true);
      expect(engineAdapter.connect).toHaveBeenCalledWith({
        type: "atem",
        ip: "192.168.1.10",
        port: 9910,
      });
    });

    it("engine_disconnect returns state after disconnect", async () => {
      const result = await commandRouter.handleCommand("engine_disconnect", {});
      expect(result.success).toBe(true);
      expect(require("./engine-adapter.js").engineAdapter.disconnect).toHaveBeenCalled();
    });

    it("engine_run_macro returns macroId and state", async () => {
      const { engineAdapter } = require("./engine-adapter.js");
      engineAdapter.getState.mockReturnValue({
        status: "connected",
        type: "atem",
        macros: [],
      });

      const result = await commandRouter.handleCommand("engine_run_macro", {
        macroId: 5,
      });
      expect(result.success).toBe(true);
      expect(engineAdapter.runMacro).toHaveBeenCalledWith(5);
      expect(result.data).toMatchObject({ macroId: 5 });
    });

    it("engine_stop_macro returns macroId and state", async () => {
      const result = await commandRouter.handleCommand("engine_stop_macro", {
        macroId: 3,
      });
      expect(result.success).toBe(true);
      expect(require("./engine-adapter.js").engineAdapter.stopMacro).toHaveBeenCalledWith(3);
    });

    it("graphics_configure_outputs returns error when payload missing", async () => {
      const result = await commandRouter.handleCommand(
        "graphics_configure_outputs",
        undefined
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing payload");
    });

    it("graphics_configure_outputs succeeds with payload", async () => {
      const { graphicsManager } = require("./graphics/graphics-manager.js");
      const result = await commandRouter.handleCommand(
        "graphics_configure_outputs",
        { version: 1, outputKey: "video_hdmi", targets: {}, format: {} }
      );
      expect(result.success).toBe(true);
      expect(graphicsManager.configureOutputs).toHaveBeenCalled();
    });

    it("graphics_test_pattern succeeds without payload", async () => {
      const { graphicsManager } = require("./graphics/graphics-manager.js");
      const result = await commandRouter.handleCommand("graphics_test_pattern");
      expect(result.success).toBe(true);
      expect(graphicsManager.sendTestPattern).toHaveBeenCalled();
    });

    it("graphics_list returns graphics status", async () => {
      const { graphicsManager } = require("./graphics/graphics-manager.js");
      graphicsManager.getStatus.mockReturnValue({
        outputConfig: null,
        activePreset: null,
        activePresets: [],
      });

      const result = await commandRouter.handleCommand("graphics_list");
      expect(result.success).toBe(true);
      expect(graphicsManager.initialize).toHaveBeenCalled();
      expect(result.data).toMatchObject({ outputConfig: null });
    });

    it("bridge_pair_validate returns error when pairing not enabled", async () => {
      const { getBridgeContext } = require("./bridge-context.js");
      getBridgeContext.mockReturnValue({
        pairingCode: null,
        pairingExpiresAt: null,
        bridgeId: null,
        bridgeName: null,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      const result = await commandRouter.handleCommand("bridge_pair_validate", {
        pairingCode: "ABCD",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Pairing is not enabled");
    });

    it("bridge_pair_validate returns error for invalid pairing code", async () => {
      const { getBridgeContext } = require("./bridge-context.js");
      getBridgeContext.mockReturnValue({
        pairingCode: "CORRECT",
        pairingExpiresAt: Date.now() + 3600000,
        bridgeId: "bridge-1",
        bridgeName: "test",
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      const result = await commandRouter.handleCommand("bridge_pair_validate", {
        pairingCode: "WRONG",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid pairing code");
    });

    it("returns validation error for invalid engine_connect payload", async () => {
      const result = await commandRouter.handleCommand("engine_connect", {
        type: "atem",
        ip: "not-an-ip",
        port: 9910,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid payload");
    });

    it("returns validation error for invalid engine_run_macro payload", async () => {
      const result = await commandRouter.handleCommand("engine_run_macro", {
        macroId: "not-a-number",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Macro ID");
    });

    it("propagates GraphicsError with errorCode", async () => {
      const { GraphicsError } = require("./graphics/graphics-errors.js");
      const { graphicsManager } = require("./graphics/graphics-manager.js");
      graphicsManager.configureOutputs.mockRejectedValue(
        new GraphicsError("output_config_error", "Invalid output config")
      );

      const result = await commandRouter.handleCommand(
        "graphics_configure_outputs",
        { version: 1 }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid output config");
      expect(result.errorCode).toBe("output_config_error");
    });
  });
});
