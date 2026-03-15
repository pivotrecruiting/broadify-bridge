import { setBridgeContext } from "../../services/bridge-context.js";
import { DisplayModule } from "./display-module.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe("DisplayModule", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp/test",
      logger: mockLogger,
      logPath: "/tmp/test/bridge.log",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  describe("name", () => {
    it("exposes module name display", () => {
      const module = new DisplayModule();
      expect(module.name).toBe("display");
    });
  });

  describe("detect", () => {
    it("returns empty array on unsupported platform (linux)", async () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });
      const module = new DisplayModule();
      const result = await module.detect();
      expect(result).toEqual([]);
    });
  });

  describe("createController", () => {
    it("returns controller with open, close, getStatus", () => {
      const module = new DisplayModule();
      const controller = module.createController("display-1");
      expect(controller).toBeDefined();
      expect(typeof controller.open).toBe("function");
      expect(typeof controller.close).toBe("function");
      expect(typeof controller.getStatus).toBe("function");
    });

    it("getStatus returns present status", async () => {
      const module = new DisplayModule();
      const controller = module.createController("display-1");
      const status = await controller.getStatus();
      expect(status.present).toBe(true);
      expect(status.ready).toBe(true);
      expect(typeof status.lastSeen).toBe("number");
    });

    it("open and close log without throwing", async () => {
      const module = new DisplayModule();
      const controller = module.createController("display-1");
      await expect(controller.open()).resolves.toBeUndefined();
      await expect(controller.close()).resolves.toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Open requested")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Close requested")
      );
    });
  });
});
