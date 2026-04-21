import { EngineAdapterService } from "./engine-adapter.js";
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
  const service = new EngineAdapterService({
    createAdapter: () => adapter,
    broadcast: (topic, message) => {
      broadcasts.push({ topic, message: message as Record<string, unknown> });
    },
  });
  return { service, adapter, broadcasts };
};

describe("EngineAdapterService", () => {
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
