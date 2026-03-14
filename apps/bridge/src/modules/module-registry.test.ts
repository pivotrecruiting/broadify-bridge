import type { DeviceDescriptorT } from "@broadify/protocol";
import type { DeviceModule, DeviceController } from "./device-module.js";
import { ModuleRegistry } from "./module-registry.js";

const createMockModule = (
  name: string,
  devices: DeviceDescriptorT[],
  delayMs = 0
): DeviceModule => {
  const detect = () =>
    delayMs > 0
      ? new Promise<DeviceDescriptorT[]>((resolve) =>
          setTimeout(() => resolve(devices), delayMs)
        )
      : Promise.resolve(devices);
  return {
    name,
    detect,
    createController: (deviceId: string) =>
      Promise.resolve({
        deviceId,
        start: jest.fn(),
        stop: jest.fn(),
      } as unknown as DeviceController),
  };
};

describe("ModuleRegistry", () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
  });

  describe("register and getModuleNames", () => {
    it("registers modules and returns names", () => {
      registry.register(
        createMockModule("mod1", [])
      );
      registry.register(
        createMockModule("mod2", [])
      );
      expect(registry.getModuleNames()).toEqual(["mod1", "mod2"]);
      expect(registry.getModuleCount()).toBe(2);
    });
  });

  describe("detectAll", () => {
    it("returns merged devices from all modules", async () => {
      registry.register(
        createMockModule("mod1", [
          { id: "dev1", name: "Device 1", type: "decklink", available: true },
        ])
      );
      registry.register(
        createMockModule("mod2", [
          { id: "dev2", name: "Device 2", type: "display", available: true },
        ])
      );
      const devices = await registry.detectAll(5000);
      expect(devices).toHaveLength(2);
      expect(devices.map((d) => d.id)).toEqual(["dev1", "dev2"]);
    });

    it("returns empty array when no modules", async () => {
      const devices = await registry.detectAll(5000);
      expect(devices).toEqual([]);
    });

    it("isolates errors and returns empty for failed module", async () => {
      const errorModule: DeviceModule = {
        name: "broken",
        detect: () => Promise.reject(new Error("detection failed")),
        createController: () => Promise.reject(new Error("no controller")),
      };
      registry.register(errorModule);
      registry.register(
        createMockModule("ok", [
          { id: "dev1", name: "OK", type: "display", available: true },
        ])
      );
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const devices = await registry.detectAll(5000);
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe("dev1");
      consoleSpy.mockRestore();
    });

    it("times out slow modules", async () => {
      const slowModule: DeviceModule = {
        name: "slow",
        detect: () => new Promise(() => {}),
        createController: () => Promise.reject(new Error("no controller")),
      };
      registry.register(slowModule);
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const devices = await registry.detectAll(50);
      expect(devices).toEqual([]);
      consoleSpy.mockRestore();
    });
  });

  describe("getController", () => {
    it("returns controller for detected device", async () => {
      registry.register(
        createMockModule("mod1", [
          { id: "dev1", name: "Device 1", type: "decklink", available: true },
        ])
      );
      const controller = await registry.getController("dev1");
      expect(controller).toBeDefined();
      expect(controller.deviceId).toBe("dev1");
    });

    it("throws when device not found", async () => {
      registry.register(createMockModule("mod1", []));
      await expect(registry.getController("missing")).rejects.toThrow(
        "Device missing not found"
      );
    });
  });

  describe("watchAll", () => {
    it("returns unsubscribe function", () => {
      registry.register(createMockModule("mod1", []));
      const callback = jest.fn();
      const unsubscribe = registry.watchAll(callback);
      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });
  });
});
