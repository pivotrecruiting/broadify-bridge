import { EngineAdapterService } from "./engine-adapter.js";
import {
  EngineError,
  EngineErrorCode,
} from "./engine/engine-errors.js";
import type {
  EngineAdapter,
  EngineConnectConfig,
} from "./engine/engine-adapter-interface.js";
import type { EngineStateT, EngineStatusT, MacroT } from "./engine-types.js";

type BroadcastCallT = {
  topic: "engine";
  message: Record<string, unknown>;
};

class FakeAdapter implements EngineAdapter {
  public connectCalls: EngineConnectConfig[] = [];
  public disconnectCalls = 0;
  public runMacroCalls: number[] = [];
  public stopMacroCalls: number[] = [];
  public unsubscribeCalls = 0;

  private stateChangeCallback: (state: EngineStateT) => void = () => {};
  private status: EngineStatusT = "disconnected";
  private macros: MacroT[] = [];

  connectImpl?: (config: EngineConnectConfig) => Promise<void>;
  disconnectImpl?: () => Promise<void>;
  runMacroImpl?: (id: number) => Promise<void>;
  stopMacroImpl?: (id: number) => Promise<void>;

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
  });
});
