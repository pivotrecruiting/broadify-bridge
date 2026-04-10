import type { EngineAdapter, EngineConnectConfig } from "./engine-adapter-interface.js";
import { AtemAdapter } from "./adapters/atem-adapter.js";

jest.mock("atem-connection", () => ({
  Atem: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
}));

describe("engine-adapter-interface", () => {
  describe("EngineAdapter contract", () => {
    it("AtemAdapter implements EngineAdapter", () => {
      const adapter: EngineAdapter = new AtemAdapter();
      expect(typeof adapter.connect).toBe("function");
      expect(typeof adapter.disconnect).toBe("function");
      expect(typeof adapter.getStatus).toBe("function");
      expect(typeof adapter.getMacros).toBe("function");
      expect(typeof adapter.runMacro).toBe("function");
      expect(typeof adapter.stopMacro).toBe("function");
      expect(typeof adapter.onStateChange).toBe("function");
    });

    it("AtemAdapter getStatus returns initial disconnected state", () => {
      const adapter = new AtemAdapter();
      expect(adapter.getStatus()).toBe("disconnected");
    });

    it("AtemAdapter getMacros returns empty array initially", () => {
      const adapter = new AtemAdapter();
      expect(adapter.getMacros()).toEqual([]);
    });
  });

  describe("EngineConnectConfig", () => {
    it("accepts valid config shape", () => {
      const config: EngineConnectConfig = {
        type: "atem",
        ip: "192.168.1.10",
        port: 9910,
      };
      expect(config.type).toBe("atem");
      expect(config.ip).toBe("192.168.1.10");
      expect(config.port).toBe(9910);
    });
  });
});
