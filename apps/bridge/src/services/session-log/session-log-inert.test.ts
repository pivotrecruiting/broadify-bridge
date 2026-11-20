import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setBridgeContext, type BridgeContextT } from "../bridge-context.js";
import { EngineAdapterService } from "../engine-adapter.js";
import type { EngineAdapter, EngineConnectConfig } from "../engine/engine-adapter-interface.js";
import { AtemAdapter } from "../engine/adapters/atem-adapter.js";
import { VmixAdapter } from "../engine/adapters/vmix-adapter.js";
import type { EngineStateT } from "../engine-types.js";
import {
  getSessionEventRecorder,
  initializeSessionLog,
  isSessionLogEnabled,
  recordSwitcherEvent,
  resetSessionEventRecorderForTests,
} from "./session-log-service.js";

const mockRequestTime = jest.fn().mockResolvedValue(undefined);

jest.mock("atem-connection", () => ({
  Atem: jest.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return {
      connect: () => {
        setImmediate(() => emitter.emit("connected"));
        return Promise.resolve();
      },
      disconnect: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      requestTime: mockRequestTime,
      state: {
        macro: { macroProperties: [] },
        info: { lastTime: { hour: 10, minute: 0, second: 0, frame: 0, dropFrame: false } },
        video: { mixEffects: [{ programInput: 1, previewInput: 2, upstreamKeyers: [] }], downstreamKeyers: [] },
      },
      emit: emitter.emit.bind(emitter),
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    };
  }),
}));

jest.mock("../engine/engine-connection-store.js", () => ({
  engineConnectionStore: { save: jest.fn().mockResolvedValue(undefined), load: jest.fn().mockResolvedValue(null) },
}));

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const setContext = async (overrides: Partial<BridgeContextT> = {}) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-log-inert-"));
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt"), ...overrides });
  return { userDataDir, logger };
};

class FakeSwitcherAdapter implements EngineAdapter {
  readonly onSwitcherEvent = jest.fn((_callback: (event: unknown) => void) => () => undefined);
  private stateChange: (state: EngineStateT) => void = () => undefined;

  async connect(config: EngineConnectConfig): Promise<void> {
    this.stateChange({ status: "connected", type: config.type, ip: config.ip, port: config.port, macros: [] });
  }
  async disconnect(): Promise<void> {}
  getStatus() {
    return "connected" as const;
  }
  getMacros() {
    return [];
  }
  async runMacro(): Promise<void> {}
  async stopMacro(): Promise<void> {}
  onStateChange(callback: (state: EngineStateT) => void): () => void {
    this.stateChange = callback;
    return () => undefined;
  }
}

const createEngineService = (adapter: FakeSwitcherAdapter, extraDeps = {}) =>
  new EngineAdapterService({
    createAdapter: () => adapter as unknown as EngineAdapter,
    broadcast: () => undefined,
    persistConnection: jest.fn().mockResolvedValue(undefined),
    ...extraDeps,
  } as ConstructorParameters<typeof EngineAdapterService>[0]);

class FakeSocket extends EventEmitter {
  readonly connect = jest.fn();
  readonly write = jest.fn();
  readonly setTimeout = jest.fn();
  readonly setKeepAlive = jest.fn();
  readonly destroy = jest.fn();
}

const okResponse = (body: string) => ({ ok: true, status: 200, statusText: "OK", text: () => Promise.resolve(body) });

/**
 * ADR-0008: without a post-production URL the session log does not exist -
 * no directory, no timers, no extra switcher traffic.
 */
describe("session log is inert without a post-production URL", () => {
  afterEach(() => {
    resetSessionEventRecorderForTests();
    jest.useRealTimers();
    mockRequestTime.mockClear();
  });

  it("reports disabled and creates neither recorder nor directory", async () => {
    const { userDataDir, logger } = await setContext({ bridgeId: "bridge-1" });
    expect(isSessionLogEnabled()).toBe(false);
    initializeSessionLog();
    expect(getSessionEventRecorder()).toBeNull();

    recordSwitcherEvent({ type: "recording_started", source: "atem", at_ms: 1000 });
    recordSwitcherEvent({ type: "program_changed", source: "atem", me: 0, input_id: "1", at_ms: 1500 });
    recordSwitcherEvent({ type: "recording_stopped", source: "atem", at_ms: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 1200)); // past the recorder's flush delay

    expect(await pathExists(path.join(userDataDir, "session-log"))).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("EngineAdapterService never subscribes to switcher events", async () => {
    await setContext();
    const adapter = new FakeSwitcherAdapter();
    const service = createEngineService(adapter);
    await service.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
    expect(adapter.onSwitcherEvent).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it("EngineAdapterService subscribes once the feature is on", async () => {
    await setContext({ postproApiUrl: "https://postpro.example" });
    const adapter = new FakeSwitcherAdapter();
    const service = createEngineService(adapter, { switcherEventSink: jest.fn() });
    await service.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
    expect(adapter.onSwitcherEvent).toHaveBeenCalledTimes(1);
    await service.disconnect();
  });

  it("AtemAdapter never requests the time and keeps no snapshot without listeners", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    const adapter = new AtemAdapter();
    await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
    const internals = adapter as unknown as {
      atemConnection: { emit: (event: string) => void };
      lastSwitcherState: unknown;
      timecodeReading: unknown;
      timecodeTimer: unknown;
    };
    internals.atemConnection.emit("stateChanged");
    jest.advanceTimersByTime(10_000);

    expect(mockRequestTime).not.toHaveBeenCalled();
    expect(internals.timecodeTimer).toBeNull();
    expect(internals.lastSwitcherState).toBeUndefined();
    expect(internals.timecodeReading).toBeNull();
    expect(adapter.getTimecode()).toBeNull();
    await adapter.disconnect();
  });

  it("VmixAdapter never opens the TCP activator connection (8099) without listeners", async () => {
    const createActivatorSocket = jest.fn(() => new FakeSocket() as unknown as Socket);
    const mockFetch = jest.fn().mockResolvedValue(okResponse("<vmix><version>29.0.0.47</version></vmix>"));
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
    try {
      const adapter = new VmixAdapter({ createActivatorSocket });
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(createActivatorSocket).not.toHaveBeenCalled();
      expect((adapter as unknown as { activators: unknown }).activators).toBeNull();
      // The inputs list is only fetched for event names.
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes("8099"))).toBe(false);
      await adapter.disconnect();
      expect(createActivatorSocket).not.toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
