import { EventEmitter } from "events";
import { AtemAdapter } from "./atem-adapter.js";

const mockAtemConnect = jest.fn();
const mockAtemDisconnect = jest.fn();
const mockMacroRun = jest.fn().mockResolvedValue(undefined);

type MockAtemBehavior = "connect" | "error" | "timeout";
let mockAtemBehavior: MockAtemBehavior = "connect";
let mockAtemError: Error | string = new Error("ECONNREFUSED");

const createMockState = (overrides?: {
  macroProperties?: Array<{ name?: string }>;
  macroRecorder?: { isRecording?: boolean; macroIndex?: number };
  macroPlayer?: { isPlaying?: boolean; isRunning?: boolean; macroIndex?: number };
}) => ({
  macro: {
    macroProperties: overrides?.macroProperties ?? [
      { name: "Macro 1" },
      { name: "Macro 2" },
    ],
    macroRecorder: overrides?.macroRecorder,
    macroPlayer: overrides?.macroPlayer,
  },
});

jest.mock("atem-connection", () => {
  return {
    Atem: jest.fn().mockImplementation(() => {
      const emitter = new EventEmitter();
      const state = createMockState();
      const atemInstance = {
        connect: (ip: string, port: number) => {
          mockAtemConnect(ip, port);
          if (mockAtemBehavior === "connect") {
            setImmediate(() => emitter.emit("connected"));
          } else if (mockAtemBehavior === "error") {
            setImmediate(() =>
              emitter.emit("error", mockAtemError instanceof Error ? mockAtemError : new Error(mockAtemError))
            );
          }
          // timeout: don't emit anything
        },
        disconnect: mockAtemDisconnect,
        macroRun: mockMacroRun,
        state,
        on: emitter.on.bind(emitter),
        once: emitter.once.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
      };
      return atemInstance;
    }),
  };
});

describe("AtemAdapter", () => {
  let adapter: AtemAdapter;

  beforeEach(() => {
    jest.useRealTimers();
    adapter = new AtemAdapter();
    mockAtemConnect.mockClear();
    mockAtemDisconnect.mockClear();
    mockMacroRun.mockClear();
    mockAtemBehavior = "connect";
    mockAtemError = new Error("ECONNREFUSED");
  });

  describe("connect", () => {
    it("throws when config type is not atem", async () => {
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow('AtemAdapter only supports type "atem"');
    });

    it("throws when already connected", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.2", port: 9910 })
      ).rejects.toThrow("already connected");
    });

    it("connects successfully and calls Atem.connect", async () => {
      await adapter.connect({ type: "atem", ip: "192.168.1.100", port: 9910 });
      expect(mockAtemConnect).toHaveBeenCalledWith("192.168.1.100", 9910);
      expect(adapter.getStatus()).toBe("connected");
    });

    it("handles ECONNREFUSED error and sets error state", async () => {
      mockAtemBehavior = "error";
      mockAtemError = new Error("ECONNREFUSED Connection refused");
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow("Connection refused");
      expect(adapter.getStatus()).toBe("error");
    });

    it("handles ENOTFOUND error as device unreachable", async () => {
      mockAtemBehavior = "error";
      mockAtemError = new Error("ENOTFOUND getaddrinfo");
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow("Device unreachable");
    });

    it("handles ETIMEDOUT error as connection timeout", async () => {
      mockAtemBehavior = "error";
      mockAtemError = new Error("ETIMEDOUT connection timeout");
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow("Connection timeout");
    });

    it("handles generic network error", async () => {
      mockAtemBehavior = "error";
      mockAtemError = new Error("Some network failure");
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow("Network error");
    });

    it("handles string error in onError", async () => {
      mockAtemBehavior = "error";
      mockAtemError = "ECONNREFUSED";
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow("Connection refused");
    });

    it("times out when connection does not complete", async () => {
      jest.useFakeTimers();
      mockAtemBehavior = "timeout";
      const connectPromise = adapter.connect({
        type: "atem",
        ip: "10.0.0.1",
        port: 9910,
      });
      const expectPromise = expect(connectPromise).rejects.toThrow(
        "Connection timeout"
      );
      await jest.advanceTimersByTimeAsync(10001);
      await expectPromise;
      expect(adapter.getStatus()).toBe("error");
      jest.useRealTimers();
    });
  });

  describe("disconnect", () => {
    it("resets state and calls Atem.disconnect", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await adapter.disconnect();
      expect(mockAtemDisconnect).toHaveBeenCalled();
      expect(adapter.getStatus()).toBe("disconnected");
    });

    it("handles disconnect errors gracefully", async () => {
      mockAtemDisconnect.mockRejectedValueOnce(new Error("Disconnect failed"));
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await expect(adapter.disconnect()).resolves.not.toThrow();
      expect(adapter.getStatus()).toBe("disconnected");
    });
  });

  describe("getStatus", () => {
    it("returns disconnected initially", () => {
      expect(adapter.getStatus()).toBe("disconnected");
    });
  });

  describe("getMacros", () => {
    it("returns macros from state after connect", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const macros = adapter.getMacros();
      expect(macros.length).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(macros)).toBe(true);
    });
  });

  describe("runMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.runMacro(0)).rejects.toThrow("Engine is not connected");
    });

    it("calls macroRun when connected", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await adapter.runMacro(0);
      expect(mockMacroRun).toHaveBeenCalledWith(0);
    });

    it("throws with slot number when macroRun fails", async () => {
      mockMacroRun.mockRejectedValueOnce(new Error("Macro error"));
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await expect(adapter.runMacro(1)).rejects.toThrow(
        "Failed to run macro 1 (slot 2): Macro error"
      );
    });
  });

  describe("stopMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.stopMacro(0)).rejects.toThrow("Engine is not connected");
    });

    it("throws when macroStop is not available", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await expect(adapter.stopMacro(0)).rejects.toThrow(
        "macroStop method not available"
      );
    });
  });

  describe("onStateChange", () => {
    it("calls callback on state change and returns unsubscribe", async () => {
      const callback = jest.fn();
      const unsubscribe = adapter.onStateChange(callback);
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      expect(callback).toHaveBeenCalled();
      unsubscribe();
      callback.mockClear();
      await adapter.disconnect();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("getState", () => {
    it("returns full state with lastUpdate", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const state = adapter.getState();
      expect(state.status).toBe("connected");
      expect(state.ip).toBe("10.0.0.1");
      expect(state.port).toBe(9910);
      expect(state.type).toBe("atem");
      expect(typeof state.lastUpdate).toBe("number");
    });
  });
});
