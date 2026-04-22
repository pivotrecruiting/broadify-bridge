import { EventEmitter } from "events";
import { AtemAdapter } from "./atem-adapter.js";

const mockAtemConnect = jest.fn();
const mockAtemDisconnect = jest.fn();
const mockMacroRun = jest.fn().mockResolvedValue(undefined);
const mockMacroStop = jest.fn().mockResolvedValue(undefined);

type MockAtemBehavior = "connect" | "error" | "timeout";
let mockAtemBehavior: MockAtemBehavior = "connect";
let mockAtemError: Error | string = new Error("ECONNREFUSED");

const createMockState = (overrides?: {
  macroProperties?: Array<{ name?: string }>;
  macroRecorder?: { isRecording?: boolean; macroIndex?: number };
  macroPlayer?: {
    isRunning?: boolean;
    isWaiting?: boolean;
    loop?: boolean;
    macroIndex?: number;
  };
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
        macroStop: mockMacroStop,
        state,
        emit: emitter.emit.bind(emitter),
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
    mockMacroStop.mockClear();
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

    it("marks pending macro before device state confirmation", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const runPromise = adapter.runMacro(1);
      expect(adapter.getMacros()).toEqual([
        { id: 0, name: "Macro 1", status: "idle" },
        { id: 1, name: "Macro 2", status: "pending" },
      ]);
      await runPromise;
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

    it("keeps the engine connected when a runtime error event arrives", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const atemConnection = (
        adapter as unknown as {
          atemConnection: {
            emit: (event: string, payload?: unknown) => void;
          };
        }
      ).atemConnection;

      atemConnection.emit("error", new Error("Macro runtime warning"));

      expect(adapter.getState()).toMatchObject({
        status: "connected",
        error: "Macro runtime warning",
      });
    });
  });

  describe("stopMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.stopMacro(0)).rejects.toThrow("Engine is not connected");
    });

    it("calls macroStop when connected", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await adapter.stopMacro(0);
      expect(mockMacroStop).toHaveBeenCalledWith();
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

    it("tracks macro execution lifecycle", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const atemConnection = (
        adapter as unknown as { atemConnection: ReturnType<typeof createMockState> }
      ).atemConnection as unknown as {
        state: ReturnType<typeof createMockState>;
      };

      await adapter.runMacro(1);
      expect(adapter.getState().macroExecution).toMatchObject({
        macroId: 1,
        macroName: "Macro 2",
        engineType: "atem",
        status: "pending",
      });

      atemConnection.state.macro.macroPlayer = {
        isRunning: true,
        isWaiting: false,
        loop: false,
        macroIndex: 1,
      };
      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();
      expect(adapter.getState().macroExecution).toMatchObject({
        macroId: 1,
        status: "running",
        startedAt: expect.any(Number),
      });

      atemConnection.state.macro.macroPlayer = {
        isRunning: false,
        isWaiting: true,
        loop: false,
        macroIndex: 1,
      };
      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();
      expect(adapter.getState().macroExecution).toMatchObject({
        macroId: 1,
        status: "waiting",
        waitingAt: expect.any(Number),
      });

      atemConnection.state.macro.macroPlayer = {
        isRunning: false,
        isWaiting: false,
        loop: false,
        macroIndex: 1,
      };
      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();
      expect(adapter.getState().macroExecution).toBeNull();
      expect(adapter.getState().lastCompletedMacroExecution).toMatchObject({
        macroId: 1,
        status: "completed",
        actualDurationMs: expect.any(Number),
      });
    });

    it("completes an accepted fast macro when ATEM never reports running", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });

      jest.useFakeTimers();
      await adapter.runMacro(1);

      expect(adapter.getState().macroExecution).toMatchObject({
        macroId: 1,
        status: "pending",
        acceptedAt: expect.any(Number),
      });

      await jest.advanceTimersByTimeAsync(750);

      expect(adapter.getState().macroExecution).toBeNull();
      expect(adapter.getState().lastCompletedMacroExecution).toMatchObject({
        macroId: 1,
        status: "completed",
        startedAt: null,
        actualDurationMs: null,
      });

      jest.useRealTimers();
    });
  });

  describe("macro status mapping", () => {
    it("maps recorder state to recording", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const atemConnection = (
        adapter as unknown as { atemConnection: ReturnType<typeof createMockState> & EventEmitter }
      ).atemConnection as unknown as {
        state: ReturnType<typeof createMockState>;
      };
      atemConnection.state.macro.macroRecorder = {
        isRecording: true,
        macroIndex: 1,
      };

      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();

      expect(adapter.getMacros()).toEqual([
        { id: 0, name: "Macro 1", status: "idle" },
        { id: 1, name: "Macro 2", status: "recording" },
      ]);
    });

    it("maps player waiting state to waiting", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const atemConnection = (
        adapter as unknown as { atemConnection: ReturnType<typeof createMockState> }
      ).atemConnection as unknown as {
        state: ReturnType<typeof createMockState>;
      };
      atemConnection.state.macro.macroPlayer = {
        isRunning: false,
        isWaiting: true,
        loop: false,
        macroIndex: 0,
      };

      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();

      expect(adapter.getMacros()).toEqual([
        { id: 0, name: "Macro 1", status: "waiting" },
        { id: 1, name: "Macro 2", status: "idle" },
      ]);
    });

    it("maps player running state to running", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const atemConnection = (
        adapter as unknown as { atemConnection: ReturnType<typeof createMockState> }
      ).atemConnection as unknown as {
        state: ReturnType<typeof createMockState>;
      };
      atemConnection.state.macro.macroPlayer = {
        isRunning: true,
        isWaiting: false,
        loop: true,
        macroIndex: 1,
      };

      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();

      expect(adapter.getMacros()).toEqual([
        { id: 0, name: "Macro 1", status: "idle" },
        { id: 1, name: "Macro 2", status: "running" },
      ]);
    });

    it("does not infer running from macroIndex alone", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      const atemConnection = (
        adapter as unknown as { atemConnection: ReturnType<typeof createMockState> }
      ).atemConnection as unknown as {
        state: ReturnType<typeof createMockState>;
      };
      atemConnection.state.macro.macroPlayer = {
        isRunning: false,
        isWaiting: false,
        loop: false,
        macroIndex: 1,
      };

      (
        adapter as unknown as { updateMacrosFromState: () => void }
      ).updateMacrosFromState();

      expect(adapter.getMacros()).toEqual([
        { id: 0, name: "Macro 1", status: "idle" },
        { id: 1, name: "Macro 2", status: "idle" },
      ]);
    });
  });
});
