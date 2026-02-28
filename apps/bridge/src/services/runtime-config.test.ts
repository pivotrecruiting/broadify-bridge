import { RuntimeConfigService } from "./runtime-config.js";

describe("RuntimeConfigService", () => {
  it("starts idle without config", () => {
    const service = new RuntimeConfigService();

    expect(service.getConfig()).toBeNull();
    expect(service.getState()).toBe("idle");
    expect(service.hasOutputs()).toBe(false);
    expect(service.hasEngine()).toBe(false);
    expect(service.getEngineConfig()).toBeUndefined();
  });

  it("moves to configured when outputs or engine are set", () => {
    const service = new RuntimeConfigService();

    service.setConfig({
      outputs: {
        output1: "deck-1",
        output2: "sdi",
      },
    });

    expect(service.getState()).toBe("configured");
    expect(service.hasOutputs()).toBe(true);
    expect(service.hasEngine()).toBe(false);
  });

  it("moves to active only when config exists", () => {
    const service = new RuntimeConfigService();

    service.setActive();
    expect(service.getState()).toBe("idle");

    service.setConfig({
      engine: {
        type: "atem",
        ip: "10.0.0.10",
        port: 9910,
      },
    });
    service.setActive();

    expect(service.getState()).toBe("active");
    expect(service.hasEngine()).toBe(true);
    expect(service.getEngineConfig()).toEqual({
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
    });
  });

  it("clears back to idle", () => {
    const service = new RuntimeConfigService();
    service.setConfig({
      outputs: {
        output1: "deck-1",
        output2: "sdi",
      },
    });

    service.clear();

    expect(service.getConfig()).toBeNull();
    expect(service.getState()).toBe("idle");
    expect(service.hasOutputs()).toBe(false);
    expect(service.hasEngine()).toBe(false);
  });
});
