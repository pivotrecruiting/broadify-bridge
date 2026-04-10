import {
  resolveUserDataDir,
  setBridgeContext,
  getBridgeContext,
} from "./bridge-context.js";

describe("bridge-context", () => {
  afterEach(() => {
    setBridgeContext({
      userDataDir: "/tmp/test",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      logPath: "/tmp/test/bridge.log",
    });
  });

  describe("resolveUserDataDir", () => {
    it("returns userDataDir when set in config", () => {
      const result = resolveUserDataDir({
        host: "127.0.0.1",
        port: 8787,
        mode: "local",
        userDataDir: "/custom/data",
      });
      expect(result).toBe("/custom/data");
    });

    it("returns default path when userDataDir not set", () => {
      const result = resolveUserDataDir({
        host: "127.0.0.1",
        port: 8787,
        mode: "local",
      });
      expect(result).toContain(".bridge-data");
      expect(result).toContain(process.cwd());
    });
  });

  describe("setBridgeContext and getBridgeContext", () => {
    it("stores and retrieves context", () => {
      const context = {
        userDataDir: "/tmp/bridge",
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        logPath: "/tmp/bridge/bridge.log",
      };
      setBridgeContext(context);
      expect(getBridgeContext()).toEqual(context);
    });

    it("returns same reference after set", () => {
      const context = {
        userDataDir: "/tmp/bridge",
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        logPath: "/tmp/bridge/bridge.log",
      };
      setBridgeContext(context);
      expect(getBridgeContext()).toBe(context);
    });
  });
});
