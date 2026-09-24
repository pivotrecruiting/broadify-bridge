import { EngineAdapterService } from "./engine-adapter.js";
import { setBridgeContext } from "./bridge-context.js";
import {
  EngineError,
  EngineErrorCode,
} from "./engine/engine-errors.js";
import type {
  EngineAdapter,
  EngineConnectConfig,
  EnsureVmixBrowserInputConfigT,
  EnsureVmixBrowserInputResultT,
  VmixActionConfigT,
  VmixActionResultT,
} from "./engine/engine-adapter-interface.js";
import type { EngineStateT, EngineStatusT, MacroT } from "./engine-types.js";

const mockEngineConnectionSave = jest.fn().mockResolvedValue(undefined);
jest.mock("./engine/engine-connection-store.js", () => ({
  engineConnectionStore: {
    save: (...args: unknown[]) => mockEngineConnectionSave(...args),
  },
}));

type BroadcastCallT = {
  topic: "engine" | "video";
  message: Record<string, unknown>;
};

class FakeAdapter implements EngineAdapter {
  public connectCalls: EngineConnectConfig[] = [];
  public disconnectCalls = 0;
  public runMacroCalls: number[] = [];
  public stopMacroCalls: number[] = [];
  public ensureVmixBrowserInputCalls: EnsureVmixBrowserInputConfigT[] = [];
  public runVmixActionCalls: VmixActionConfigT[] = [];
  public unsubscribeCalls = 0;

  private stateChangeCallback: (state: EngineStateT) => void = () => {};
  private status: EngineStatusT = "disconnected";
  private macros: MacroT[] = [];

  connectImpl?: (config: EngineConnectConfig) => Promise<void>;
  disconnectImpl?: () => Promise<void>;
  runMacroImpl?: (id: number) => Promise<void>;
  stopMacroImpl?: (id: number) => Promise<void>;
  ensureVmixBrowserInputImpl?: (
    config: EnsureVmixBrowserInputConfigT
  ) => Promise<EnsureVmixBrowserInputResultT>;
  runVmixActionImpl?: (
    config: VmixActionConfigT
  ) => Promise<VmixActionResultT>;

  async connect(config: EngineConnectConfig): Promise<void> {
    this.connectCalls.push(config);
    if (this.connectImpl) {
      await this.connectImpl(config);
      return;
    }
    this.emitState({
      status: "connected",
      type: config.type,
      ip: config.ip,
      port: config.port,
      macros: [],
    });
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    if (this.disconnectImpl) {
      await this.disconnectImpl();
    }
    this.status = "disconnected";
    this.macros = [];
  }

  getStatus(): EngineStatusT {
    return this.status;
  }

  getMacros(): MacroT[] {
    return this.macros;
  }

  async runMacro(id: number): Promise<void> {
    this.runMacroCalls.push(id);
    if (this.runMacroImpl) {
      await this.runMacroImpl(id);
    }
  }

  async stopMacro(id: number): Promise<void> {
    this.stopMacroCalls.push(id);
    if (this.stopMacroImpl) {
      await this.stopMacroImpl(id);
    }
  }

  async ensureVmixBrowserInput(
    config: EnsureVmixBrowserInputConfigT
  ): Promise<EnsureVmixBrowserInputResultT> {
    this.ensureVmixBrowserInputCalls.push(config);
    if (this.ensureVmixBrowserInputImpl) {
      return this.ensureVmixBrowserInputImpl(config);
    }

    return {
      action: "created",
      inputNumber: 7,
      inputKey: "input-7",
      inputName: config.inputName,
      browserInputUrl: config.url,
    };
  }

  async runVmixAction(config: VmixActionConfigT): Promise<VmixActionResultT> {
    this.runVmixActionCalls.push(config);
    if (this.runVmixActionImpl) {
      return this.runVmixActionImpl(config);
    }

    return {
      actionType: config.actionType,
      scriptName: config.scriptName,
      executedFunction:
        config.actionType === "script_start" ? "ScriptStart" : "ScriptStop",
    };
  }

  onStateChange(callback: (state: EngineStateT) => void): () => void {
    this.stateChangeCallback = callback;
    return () => {
      this.unsubscribeCalls += 1;
      this.stateChangeCallback = () => {};
    };
  }

  emitState(state: EngineStateT): void {
    this.status = state.status;
    this.macros = state.macros;
    this.stateChangeCallback(state);
  }
}

const createService = () => {
  const adapter = new FakeAdapter();
  const broadcasts: BroadcastCallT[] = [];
  const persistConnection = jest.fn().mockResolvedValue(undefined);
  const service = new EngineAdapterService({
    createAdapter: () => adapter,
    broadcast: (topic, message) => {
      broadcasts.push({ topic, message: message as Record<string, unknown> });
    },
    persistConnection,
  } as ConstructorParameters<typeof EngineAdapterService>[0] & {
    persistConnection: typeof persistConnection;
  });
  return { service, adapter, broadcasts, persistConnection };
};

const createServiceWithAdapters = (adapters: FakeAdapter[], extraDeps = {}) => {
  const broadcasts: BroadcastCallT[] = [];
  const persistConnection = jest.fn().mockResolvedValue(undefined);
  const createAdapter = jest.fn(() => {
    const adapter = adapters.shift();
    if (!adapter) {
      throw new Error("No fake adapter left");
    }
    return adapter;
  });
  const service = new EngineAdapterService({
    createAdapter,
    broadcast: (topic, message) => {
      broadcasts.push({ topic, message: message as Record<string, unknown> });
    },
    persistConnection,
    ...extraDeps,
  } as ConstructorParameters<typeof EngineAdapterService>[0] & {
    persistConnection: typeof persistConnection;
  });
  return { service, broadcasts, persistConnection, createAdapter };
};

describe("EngineAdapterService", () => {
  const mockPublishBridgeEvent = jest.fn();
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: mockPublishBridgeEvent,
    });
  });

  afterEach(() => {
    expect(mockEngineConnectionSave).not.toHaveBeenCalled();
  });

  describe("connection supervisor", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("publishes connecting with reconnect info while an auto-reconnect is pending", async () => {
      const adapter1 = new FakeAdapter();
      const adapter2 = new FakeAdapter();
      adapter2.connectImpl = async () => {
        throw new Error("no switcher");
      };
      const { service, broadcasts } = createServiceWithAdapters([adapter1, adapter2], {
        random: () => 0.5,
      });

      await service.connect({ type: "atem", transport: "usb", ip: "", port: 0 });
      adapter1.emitState({ status: "disconnected", type: "atem", transport: "usb", macros: [] });
      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getState()).toMatchObject({
        status: "connecting",
        reconnect: { attempt: 2, lastError: "no switcher" },
      });
      expect(
        broadcasts.some((entry) => entry.message.type === "engine.error"),
      ).toBe(false);
      expect(
        mockPublishBridgeEvent.mock.calls.some(
          ([payload]) =>
            payload.event === "engine_status" &&
            payload.data?.reason === "reconnecting" &&
            payload.data?.reconnect?.attempt >= 1,
        ),
      ).toBe(true);
    });

    it("auto-reconnects a usb drop through a fresh adapter", async () => {
      const adapter1 = new FakeAdapter();
      const adapter2 = new FakeAdapter();
      const order: string[] = [];
      adapter1.disconnectImpl = async () => {
        order.push("adapter1.disconnect");
      };
      adapter2.connectImpl = async () => {
        order.push("adapter2.connect");
        adapter2.emitState({ status: "connected", type: "atem", transport: "usb", macros: [] });
      };
      const { service, createAdapter } = createServiceWithAdapters([adapter1, adapter2], {
        random: () => 0.5,
      });

      await service.connect({ type: "atem", transport: "usb", ip: "", port: 0 });
      adapter1.emitState({ status: "disconnected", type: "atem", transport: "usb", macros: [] });
      await jest.advanceTimersByTimeAsync(1000);

      expect(createAdapter).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["adapter1.disconnect", "adapter2.connect"]);
      expect(service.getStatus()).toBe("connected");
    });

    it("startPersistedAutoConnect connects the persisted config after the delay", async () => {
      const adapter = new FakeAdapter();
      const loadPersistedConnection = jest.fn().mockResolvedValue({
        type: "atem",
        transport: "usb",
        ip: "",
        port: 0,
      });
      const { service } = createServiceWithAdapters([adapter], {
        loadPersistedConnection,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      service.startPersistedAutoConnect();
      expect(adapter.connectCalls).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(3000);

      expect(loadPersistedConnection).toHaveBeenCalled();
      expect(adapter.connectCalls).toEqual([
        { type: "atem", transport: "usb", ip: "", port: 0 },
      ]);
    });

    it("startPersistedAutoConnect does nothing when already connecting", async () => {
      const adapter = new FakeAdapter();
      adapter.connectImpl = () => new Promise<void>(() => {});
      const loadPersistedConnection = jest.fn().mockResolvedValue({
        type: "atem",
        transport: "usb",
        ip: "",
        port: 0,
      });
      const { service } = createServiceWithAdapters([adapter], {
        loadPersistedConnection,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      void service.connect({ type: "atem", transport: "usb", ip: "", port: 0 });
      service.startPersistedAutoConnect();
      await jest.advanceTimersByTimeAsync(3000);

      expect(loadPersistedConnection).toHaveBeenCalled();
      expect(adapter.connectCalls).toHaveLength(1);
    });

    it("joins an in-flight auto attempt with the same config instead of throwing ALREADY_CONNECTING", async () => {
      const adapter = new FakeAdapter();
      let resolveConnect: () => void;
      adapter.connectImpl = () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        });
      const { service } = createServiceWithAdapters([adapter]);
      const connectPromise = service.connect(
        { type: "atem", transport: "usb", ip: "", port: 0 },
        "startup",
      );
      await Promise.resolve();
      await Promise.resolve();

      const joined = service.connect({ type: "atem", transport: "usb", ip: "", port: 0 });

      resolveConnect!();
      await expect(joined).resolves.toBeUndefined();
      await expect(connectPromise).resolves.toBeUndefined();
    });

    it("supersedes an in-flight startup attempt when the manual config differs", async () => {
      const adapter1 = new FakeAdapter();
      const adapter2 = new FakeAdapter();
      adapter1.connectImpl = () => new Promise<void>(() => {});
      const { service } = createServiceWithAdapters([adapter1, adapter2]);

      void service.connect({ type: "atem", transport: "usb", ip: "", port: 0 }, "startup");
      await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

      expect(adapter1.disconnectCalls).toBe(1);
      expect(adapter2.connectCalls).toEqual([
        { type: "atem", ip: "10.0.0.10", port: 9910 },
      ]);
    });

    it("a failed superseded attempt does not tear down the newer manual session", async () => {
      const adapter1 = new FakeAdapter();
      const adapter2 = new FakeAdapter();
      let rejectStartup: (error: Error) => void;
      adapter1.connectImpl = () =>
        new Promise<void>((_resolve, reject) => {
          rejectStartup = reject;
        });
      const { service } = createServiceWithAdapters([adapter1, adapter2]);

      void service.connect({ type: "atem", transport: "usb", ip: "", port: 0 }, "startup");
      await Promise.resolve();
      await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

      rejectStartup!(new Error("superseded miss"));
      await Promise.resolve();
      await Promise.resolve();

      expect(service.getStatus()).toBe("connected");
      expect(adapter2.disconnectCalls).toBe(0);
      expect(adapter1.disconnectCalls).toBe(1);
    });

    it("startup auto-connect gives up silently and leaves the state disconnected", async () => {
      const adapters = Array.from({ length: 5 }, () => {
        const adapter = new FakeAdapter();
        adapter.connectImpl = async () => {
          throw new Error("no switcher");
        };
        return adapter;
      });
      const loadPersistedConnection = jest.fn().mockResolvedValue({
        type: "atem",
        transport: "usb",
        ip: "",
        port: 0,
      });
      const { service, broadcasts, createAdapter } = createServiceWithAdapters(adapters, {
        loadPersistedConnection,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      service.startPersistedAutoConnect();
      await jest.advanceTimersByTimeAsync(3000 + 1000 + 2000 + 4000 + 8000 + 100);

      expect(createAdapter).toHaveBeenCalledTimes(5);
      expect(service.getStatus()).toBe("disconnected");
      expect(service.getState().reconnect).toBeNull();
      expect(
        broadcasts.some((entry) => entry.message.type === "engine.error"),
      ).toBe(false);
    });

    it("still rejects a second manual connect with a different config while connecting", async () => {
      const adapter = new FakeAdapter();
      adapter.connectImpl = () => new Promise<void>(() => {});
      const { service } = createServiceWithAdapters([adapter]);

      void service.connect({ type: "atem", transport: "usb", ip: "", port: 0 });

      await expect(
        service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 }),
      ).rejects.toMatchObject({
        code: EngineErrorCode.ALREADY_CONNECTING,
      });
    });

    it("a manual disconnect cancels the startup auto-connect timer", async () => {
      const adapter = new FakeAdapter();
      const loadPersistedConnection = jest.fn().mockResolvedValue({
        type: "atem",
        transport: "usb",
        ip: "",
        port: 0,
      });
      const { service } = createServiceWithAdapters([adapter], {
        loadPersistedConnection,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      service.startPersistedAutoConnect();
      await service.disconnect();
      await jest.advanceTimersByTimeAsync(3000);

      expect(loadPersistedConnection).not.toHaveBeenCalled();
      expect(adapter.connectCalls).toHaveLength(0);
    });
  });

  it("connects successfully and updates state", async () => {
    const { service, adapter, broadcasts } = createService();

    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    expect(adapter.connectCalls).toEqual([
      { type: "atem", ip: "10.0.0.10", port: 9910 },
    ]);
    expect(service.getStatus()).toBe("connected");
    expect(service.getState()).toMatchObject({
      status: "connected",
      ip: "10.0.0.10",
      port: 9910,
    });
    expect(
      broadcasts.some(
        (entry) =>
          entry.message.type === "engine.status" &&
          entry.message.status === "connected",
      ),
    ).toBe(true);
  });

  it("disconnects a lingering previous adapter before reconnecting", async () => {
    const adapter1 = new FakeAdapter();
    const adapter2 = new FakeAdapter();
    const nextAdapters = [adapter1, adapter2];
    const service = new EngineAdapterService({
      createAdapter: () => nextAdapters.shift() as FakeAdapter,
      broadcast: () => {},
      persistConnection: jest.fn().mockResolvedValue(undefined),
    });

    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });
    expect(service.getStatus()).toBe("connected");

    // Simulate an unsolicited drop: the status goes disconnected but the
    // service still holds adapter1 (its helper/socket lingers).
    adapter1.emitState({ status: "disconnected", type: "atem", macros: [] });
    expect(service.getStatus()).toBe("connecting");

    // Reconnecting must tear down the lingering adapter1 before creating
    // adapter2, so the USB helper releases its claim on the switcher.
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });
    expect(adapter1.disconnectCalls).toBe(1);
    expect(adapter2.connectCalls).toHaveLength(1);
    expect(service.getStatus()).toBe("connected");
  });

  it("rejects connect when already connected", async () => {
    const { service } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    await expect(
      service.connect({ type: "atem", ip: "10.0.0.11", port: 9910 }),
    ).rejects.toMatchObject({
      code: EngineErrorCode.ALREADY_CONNECTED,
    });
  });

  it("enforces connected state before running macros", async () => {
    const { service } = createService();

    await expect(service.runMacro(1)).rejects.toMatchObject({
      code: EngineErrorCode.NOT_CONNECTED,
    });
  });

  it("runs macro through adapter when connected", async () => {
    const { service, adapter } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    await service.runMacro(7);

    expect(adapter.runMacroCalls).toEqual([7]);
  });

  it("rethrows EngineError from adapter.runMacro unchanged", async () => {
    const { service, adapter } = createService();
    const engineError = new EngineError(
      EngineErrorCode.NOT_CONNECTED,
      "macro transport disconnected",
    );
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });
    adapter.runMacroImpl = async () => {
      throw engineError;
    };

    await expect(service.runMacro(7)).rejects.toBe(engineError);
  });

  it("wraps unknown connect errors into EngineError with UNKNOWN_ERROR", async () => {
    const { service, adapter, broadcasts } = createService();
    adapter.connectImpl = async () => {
      throw new Error("dial failed");
    };

    await expect(
      service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 }),
    ).rejects.toMatchObject({
      code: EngineErrorCode.UNKNOWN_ERROR,
    });

    const lastError = service.getLastError();
    expect(lastError).toContain("dial failed");
    expect(service.getStatus()).toBe("error");
    expect(
      broadcasts.some(
        (entry) =>
          entry.message.type === "engine.error" &&
          (entry.message.error as { message?: string })?.message?.includes(
            "dial failed",
          ),
      ),
    ).toBe(true);
  });

  it("persists the config after a successful manual connect", async () => {
    const { service, persistConnection } = createService();
    const config = { type: "atem" as const, ip: "10.0.0.10", port: 9910 };

    await service.connect(config);

    expect(persistConnection).toHaveBeenCalledWith(config);
  });

  it("does not persist when connect fails", async () => {
    const { service, adapter, persistConnection } = createService();
    adapter.connectImpl = async () => {
      throw new EngineError(EngineErrorCode.CONNECTION_REFUSED, "refused");
    };

    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 }).catch(() => {});

    expect(persistConnection).not.toHaveBeenCalled();
  });

  it("disconnects, unsubscribes adapter state, and resets service state", async () => {
    const { service, adapter, broadcasts } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    await service.disconnect();

    expect(adapter.unsubscribeCalls).toBe(1);
    expect(adapter.disconnectCalls).toBe(1);
    expect(service.getState()).toEqual({
      status: "disconnected",
      macros: [],
      macroExecution: null,
      lastCompletedMacroExecution: null,
    });
    expect(
      broadcasts.some((entry) => entry.message.type === "engine.disconnected"),
    ).toBe(true);
  });

  it("rethrows EngineError from adapter unchanged", async () => {
    const { service, adapter } = createService();
    adapter.connectImpl = async () => {
      throw new EngineError(EngineErrorCode.CONNECTION_TIMEOUT, "timed out");
    };

    await expect(
      service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 }),
    ).rejects.toMatchObject({
      code: EngineErrorCode.CONNECTION_TIMEOUT,
      message: "timed out",
    });

    expect(service.getState()).toMatchObject({
      status: "error",
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
      error: "timed out",
    });
  });

  it("rejects connect when already connecting", async () => {
    const { service, adapter } = createService();
    let resolveConnect: () => void;
    adapter.connectImpl = () =>
      new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

    const connectPromise = service.connect({
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
    });

    await expect(
      service.connect({ type: "atem", ip: "10.0.0.11", port: 9910 }),
    ).rejects.toMatchObject({
      code: EngineErrorCode.ALREADY_CONNECTING,
    });

    resolveConnect!();
    await connectPromise;
  });

  it("stopMacro throws when not connected", async () => {
    const { service } = createService();
    await expect(service.stopMacro(1)).rejects.toMatchObject({
      code: EngineErrorCode.NOT_CONNECTED,
    });
  });

  it("stopMacro propagates adapter error", async () => {
    const { service, adapter } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });
    adapter.stopMacroImpl = async () => {
      throw new Error("stop failed");
    };

    await expect(service.stopMacro(1)).rejects.toThrow(
      "Failed to stop macro 1: stop failed",
    );
  });

  it("runMacro propagates adapter error", async () => {
    const { service, adapter } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });
    adapter.runMacroImpl = async () => {
      throw new Error("run failed");
    };

    await expect(service.runMacro(1)).rejects.toThrow(
      "Failed to run macro 1: run failed",
    );
  });

  it("disconnect swallows adapter disconnect error", async () => {
    const { service, adapter } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();
    adapter.disconnectImpl = async () => {
      throw new Error("disconnect failed");
    };

    await service.disconnect();

    expect(service.getStatus()).toBe("disconnected");
    expect(consoleSpy).toHaveBeenCalledWith(
      "[EngineAdapterService] Error during disconnect:",
      "disconnect failed",
    );
    consoleSpy.mockRestore();
  });

  it("broadcasts engine.macros when macros change", async () => {
    const { service, adapter, broadcasts } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    adapter.emitState({
      status: "connected",
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
      macros: [{ id: 1, name: "Macro 1", status: "idle" }],
    });

    expect(
      broadcasts.some(
        (b) =>
          b.message.type === "engine.macros" &&
          (b.message as { macros?: unknown[] }).macros?.length === 1,
      ),
    ).toBe(true);
  });

  it("broadcasts engine.macroExecution when execution changes", async () => {
    const { service, adapter, broadcasts } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    adapter.emitState({
      status: "connected",
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
      macros: [{ id: 1, name: "Macro 1", status: "running" }],
      macroExecution: {
        runId: "run-1",
        macroId: 1,
        macroName: "Macro 1",
        engineType: "atem",
        status: "running",
        triggeredAt: 100,
        startedAt: 110,
        waitingAt: null,
        completedAt: null,
        actualDurationMs: null,
        loop: false,
        stopRequestedAt: null,
      },
      lastCompletedMacroExecution: null,
    });

    expect(
      broadcasts.some(
        (b) =>
          b.message.type === "engine.macroExecution" &&
          (b.message as { execution?: { runId?: string } }).execution?.runId ===
            "run-1",
      ),
    ).toBe(true);
  });

  it("publishes engine relay bridge events for status, execution and errors", async () => {
    const { service, adapter } = createService();

    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    adapter.emitState({
      status: "connected",
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
      macros: [{ id: 1, name: "Macro 1", status: "running" }],
      macroExecution: {
        runId: "run-1",
        macroId: 1,
        macroName: "Macro 1",
        engineType: "atem",
        status: "running",
        triggeredAt: 100,
        startedAt: 110,
        waitingAt: null,
        completedAt: null,
        actualDurationMs: null,
        loop: false,
        stopRequestedAt: null,
      },
      lastCompletedMacroExecution: null,
    });

    adapter.emitState({
      status: "error",
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
      error: "dial failed",
      macros: [],
      macroExecution: null,
      lastCompletedMacroExecution: null,
    });

    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_status",
      data: expect.objectContaining({
        reason: expect.any(String),
        status: "connected",
      }),
    });
    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_macro_execution",
      data: expect.objectContaining({
        reason: "execution_changed",
        execution: expect.objectContaining({ runId: "run-1" }),
      }),
    });
    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_error",
      data: {
        code: "engine_error",
        message: "dial failed",
      },
    });
  });

  it("publishes engine_error with the adapter's EngineErrorCode", async () => {
    const { service, adapter, broadcasts } = createService();

    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    adapter.emitState({
      status: "error",
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
      error: "timed out",
      errorCode: EngineErrorCode.CONNECTION_TIMEOUT,
      macros: [],
      macroExecution: null,
      lastCompletedMacroExecution: null,
    });

    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_error",
      data: {
        code: EngineErrorCode.CONNECTION_TIMEOUT,
        message: "timed out",
      },
    });
    expect(broadcasts).toContainEqual({
      topic: "engine",
      message: {
        type: "engine.error",
        error: {
          code: EngineErrorCode.CONNECTION_TIMEOUT,
          message: "timed out",
        },
      },
    });
  });

  it("getConnectedSince returns timestamp when connected", async () => {
    const { service } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    expect(service.getConnectedSince()).toBeGreaterThan(0);
    expect(service.getLastError()).toBeNull();
  });

  it("getLastError returns message when connect failed", async () => {
    const { service, adapter } = createService();
    adapter.connectImpl = async () => {
      throw new Error("connection failed");
    };

    await service
      .connect({ type: "atem", ip: "10.0.0.10", port: 9910 })
      .catch(() => {});

    expect(service.getLastError()).toContain("connection failed");
  });

  it("preserves connection metadata when unknown connect error is wrapped", async () => {
    const { service, adapter } = createService();
    adapter.connectImpl = async () => {
      throw new Error("dial failed");
    };

    await service
      .connect({ type: "vmix", ip: "10.0.0.20", port: 8088 })
      .catch(() => {});

    expect(service.getState()).toMatchObject({
      status: "error",
      type: "vmix",
      ip: "10.0.0.20",
      port: 8088,
    });
  });

  it("ensures a vmix browser input through the connected adapter", async () => {
    const { service, adapter } = createService();
    await service.connect({ type: "vmix", ip: "10.0.0.20", port: 8088 });

    const result = await service.ensureVmixBrowserInput({
      url: "http://127.0.0.1:8787/graphics/browser-input",
      inputName: "Broadify Browser Input",
    });

    expect(adapter.ensureVmixBrowserInputCalls).toEqual([
      {
        url: "http://127.0.0.1:8787/graphics/browser-input",
        inputName: "Broadify Browser Input",
      },
    ]);
    expect(result).toMatchObject({
      action: "created",
      inputName: "Broadify Browser Input",
    });
  });

  it("rejects vmix browser input setup when a non-vmix engine is connected", async () => {
    const { service } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    await expect(
      service.ensureVmixBrowserInput({
        url: "http://127.0.0.1:8787/graphics/browser-input",
        inputName: "Broadify Browser Input",
      }),
    ).rejects.toThrow("vMix engine is not connected");
  });

  it("runs a vmix action through the connected adapter", async () => {
    const { service, adapter } = createService();
    await service.connect({ type: "vmix", ip: "10.0.0.20", port: 8088 });

    const result = await service.runVmixAction({
      actionType: "script_start",
      scriptName: "Broadify_Button_1",
    });

    expect(adapter.runVmixActionCalls).toEqual([
      {
        actionType: "script_start",
        scriptName: "Broadify_Button_1",
      },
    ]);
    expect(result).toEqual({
      actionType: "script_start",
      scriptName: "Broadify_Button_1",
      executedFunction: "ScriptStart",
    });
  });

  it("rejects vmix action execution when a non-vmix engine is connected", async () => {
    const { service } = createService();
    await service.connect({ type: "atem", ip: "10.0.0.10", port: 9910 });

    await expect(
      service.runVmixAction({
        actionType: "script_start",
        scriptName: "Broadify_Button_1",
      }),
    ).rejects.toThrow("vMix engine is not connected");
  });
});
