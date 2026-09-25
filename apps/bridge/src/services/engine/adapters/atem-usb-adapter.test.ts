import { EventEmitter } from "events";
import {
  AtemUsbAdapter,
  __setAtemUsbHelperPathForTesting,
} from "./atem-usb-adapter.js";
import { EngineError, EngineErrorCode } from "../engine-errors.js";

const mockSpawn = jest.fn();
const mockAccess = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
}));

type MockChildT = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { writable: boolean; write: jest.Mock };
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function createMockChild(): MockChildT {
  const child = new EventEmitter() as MockChildT;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: jest.fn().mockReturnValue(true) };
  child.kill = jest.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function emitHelperLine(child: MockChildT, event: Record<string, unknown>): void {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
}

function emitExit(
  child: MockChildT,
  code: number | null = 0,
  signal: NodeJS.Signals | null = null
): void {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("AtemUsbAdapter", () => {
  let child: MockChildT;

  beforeEach(() => {
    jest.clearAllMocks();
    __setAtemUsbHelperPathForTesting("/mock/atem-usb-helper");
    mockAccess.mockResolvedValue(undefined);
    child = createMockChild();
    mockSpawn.mockReturnValue(child);
  });

  afterEach(() => {
    __setAtemUsbHelperPathForTesting(null);
  });

  const usbConfig = {
    type: "atem",
    ip: "",
    port: 0,
    transport: "usb",
  } as const;

  async function connectAdapter(
    adapter: AtemUsbAdapter,
    options: { protocolVersion?: number } = {}
  ): Promise<void> {
    const connectPromise = adapter.connect(usbConfig);
    await flush();
    emitHelperLine(child, {
      type: "ready",
      ...(options.protocolVersion ? { protocol_version: options.protocolVersion } : {}),
    });
    await flush();
    emitHelperLine(child, { type: "connected", product_name: "ATEM Mini Extreme" });
    emitHelperLine(child, {
      type: "macros",
      macros: [
        { id: 0, name: "Cam 1", description: "" },
        { id: 7, name: "BG AN", description: "" },
      ],
    });
    emitHelperLine(child, { type: "macro_state", status: "idle", loop: false, index: 65535 });
    await connectPromise;
  }

  it("rejects non-usb configs", async () => {
    const adapter = new AtemUsbAdapter();
    await expect(
      adapter.connect({ type: "atem", ip: "1.2.3.4", port: 9910 })
    ).rejects.toThrow('transport "usb"');
  });

  it("connects via helper handshake and exposes macros", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    expect(mockSpawn).toHaveBeenCalledWith(
      "/mock/atem-usb-helper",
      ["--run"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
    );
    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"connect"}\n');
    expect(adapter.getStatus()).toBe("connected");
    expect(adapter.getMacros()).toEqual([
      { id: 0, name: "Cam 1", status: "idle" },
      { id: 7, name: "BG AN", status: "idle" },
    ]);
    expect(adapter.getState().transport).toBe("usb");
  });

  it("maps atem_software_not_installed to DEVICE_NOT_FOUND", async () => {
    const adapter = new AtemUsbAdapter();
    const connectPromise = adapter.connect(usbConfig);
    await flush();
    emitHelperLine(child, { type: "ready" });
    await flush();
    emitHelperLine(child, { type: "error", error: "atem_software_not_installed" });

    await expect(connectPromise).rejects.toMatchObject({
      code: EngineErrorCode.DEVICE_NOT_FOUND,
    });
    expect(adapter.getStatus()).toBe("error");
  });

  it("maps no_usb_switcher_found to DEVICE_NOT_FOUND", async () => {
    const adapter = new AtemUsbAdapter();
    const connectPromise = adapter.connect(usbConfig);
    await flush();
    emitHelperLine(child, { type: "ready" });
    await flush();
    emitHelperLine(child, { type: "error", error: "no_usb_switcher_found" });

    await expect(connectPromise).rejects.toBeInstanceOf(EngineError);
  });

  it("maps device_busy to DEVICE_BUSY and keeps hr in details", async () => {
    const adapter = new AtemUsbAdapter();
    const connectPromise = adapter.connect(usbConfig);
    await flush();
    emitHelperLine(child, { type: "ready", protocol_version: 2 });
    await flush();
    emitHelperLine(child, {
      type: "error",
      error: "device_busy",
      detail: "hr=0x80000009 fail_reason=no_response",
      hr: "0x80000009",
      fail_reason: "no_response",
    });

    await expect(connectPromise).rejects.toMatchObject({
      code: EngineErrorCode.DEVICE_BUSY,
      details: {
        hr: "0x80000009",
        failReason: "no_response",
      },
    });
  });

  it("rejects when the helper exits before connecting", async () => {
    const adapter = new AtemUsbAdapter();
    const connectPromise = adapter.connect(usbConfig);
    await flush();
    child.emit("exit", 1, null);

    await expect(connectPromise).rejects.toMatchObject({
      code: EngineErrorCode.UNKNOWN_ERROR,
    });
  });

  it("runs a macro through the helper and tracks execution", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    await adapter.runMacro(7);
    expect(child.stdin.write).toHaveBeenCalledWith(
      '{"command":"macro_run","index":7}\n'
    );

    emitHelperLine(child, { type: "macro_state", status: "running", loop: false, index: 7 });
    await flush();
    expect(adapter.getMacros()).toEqual(
      expect.arrayContaining([{ id: 7, name: "BG AN", status: "running" }])
    );
    expect(adapter.getState().macroExecution).toMatchObject({
      macroId: 7,
      status: "running",
      engineType: "atem",
    });

    emitHelperLine(child, { type: "macro_state", status: "idle", loop: false, index: 65535 });
    await flush();
    expect(adapter.getState().macroExecution).toBeNull();
    expect(adapter.getState().lastCompletedMacroExecution).toMatchObject({
      macroId: 7,
      status: "completed",
    });
  });

  it("sends ping every 5s and treats two missed pongs as a helper drop", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter, { protocolVersion: 2 });

    expect(child.stdin.write).not.toHaveBeenCalledWith('{"command":"ping","seq":1}\n');

    await jest.advanceTimersByTimeAsync(5000);
    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"ping","seq":1}\n');
    expect(adapter.getStatus()).toBe("connected");

    await jest.advanceTimersByTimeAsync(5000);
    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"ping","seq":2}\n');
    expect(adapter.getStatus()).toBe("connected");

    await jest.advanceTimersByTimeAsync(5000);
    expect(adapter.getStatus()).toBe("disconnected");
    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"shutdown"}\n');

    jest.useRealTimers();
  });

  it("does not send pings to a protocol v1 helper", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    await jest.advanceTimersByTimeAsync(15000);

    expect(child.stdin.write).not.toHaveBeenCalledWith(
      expect.stringContaining('"command":"ping"')
    );
    expect(adapter.getStatus()).toBe("connected");

    jest.useRealTimers();
  });

  it("runMacro resolves on ack and marks the execution accepted", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter, { protocolVersion: 2 });

    const runPromise = adapter.runMacro(7);
    await flush();
    expect(child.stdin.write).toHaveBeenCalledWith(
      '{"command":"macro_run","index":7,"req":1}\n'
    );
    expect(adapter.getState().macroExecution).toMatchObject({
      macroId: 7,
      status: "pending",
      acceptedAt: null,
    });

    emitHelperLine(child, {
      type: "ack",
      command: "macro_run",
      req: 1,
      index: 7,
    });
    await runPromise;

    expect(adapter.getState().macroExecution).toMatchObject({
      macroId: 7,
      status: "pending",
      acceptedAt: expect.any(Number),
    });
  });

  it("rejects with PROTOCOL_ERROR on nack and fails the execution", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter, { protocolVersion: 2 });

    const runPromise = adapter.runMacro(7);
    await flush();
    emitHelperLine(child, {
      type: "nack",
      command: "macro_run",
      req: 1,
      index: 7,
      error: "invalid_macro_index",
    });

    await expect(runPromise).rejects.toMatchObject({
      code: EngineErrorCode.PROTOCOL_ERROR,
      details: { reason: "invalid_macro_index" },
    });
    expect(adapter.getState().macroExecution).toMatchObject({
      macroId: 7,
      status: "failed",
      error: "invalid_macro_index",
    });
    expect(adapter.getState().lastCompletedMacroExecution).toBeNull();
  });

  it("rejects when no ack arrives within 2s", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter, { protocolVersion: 2 });

    const runPromise = adapter.runMacro(7);
    await flush();
    const expectation = expect(runPromise).rejects.toMatchObject({
      code: EngineErrorCode.PROTOCOL_ERROR,
      details: { reason: "macro_ack_timeout" },
    });
    await jest.advanceTimersByTimeAsync(2000);

    await expectation;
    expect(adapter.getState().macroExecution).toMatchObject({
      macroId: 7,
      status: "failed",
      error: "macro_ack_timeout",
    });
    expect(adapter.getState().lastCompletedMacroExecution).toBeNull();

    jest.useRealTimers();
  });

  it("ignores unknown_command errors from older helpers", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    emitHelperLine(child, {
      type: "error",
      error: "unknown_command",
      detail: "ping",
    });
    await flush();

    expect(adapter.getState().error).toBeUndefined();
  });

  it("stops a macro through the helper", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    await adapter.runMacro(7);
    emitHelperLine(child, { type: "macro_state", status: "running", loop: false, index: 7 });
    await flush();
    await adapter.stopMacro(7);

    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"macro_stop"}\n');
  });

  it("marks the state disconnected and stops the helper when the switcher drops off USB", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    emitHelperLine(child, { type: "disconnected" });
    await flush();
    expect(adapter.getStatus()).toBe("disconnected");
    // The lingering helper must be told to shut down so it releases the USB
    // claim; otherwise the next connect fails until a physical replug.
    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"shutdown"}\n');
  });

  it("sends shutdown on disconnect and resets state", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    const disconnectPromise = adapter.disconnect();
    await flush();
    emitExit(child);
    await disconnectPromise;

    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"shutdown"}\n');
    expect(adapter.getStatus()).toBe("disconnected");
    expect(adapter.getMacros()).toEqual([]);
    expect(adapter.getState().transport).toBeUndefined();
  });

  it("disconnect resolves only after the helper exited", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    let resolved = false;
    const disconnectPromise = adapter.disconnect().then(() => {
      resolved = true;
    });

    await flush();
    expect(resolved).toBe(false);

    emitExit(child);
    await disconnectPromise;

    expect(resolved).toBe(true);
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("escalates to SIGTERM and SIGKILL when the helper ignores shutdown", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);
    jest.useFakeTimers();

    let resolved = false;
    const disconnectPromise = adapter.disconnect().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"shutdown"}\n');
    expect(resolved).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(4000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(resolved).toBe(false);

    await jest.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    emitExit(child, null, "SIGKILL");
    await disconnectPromise;
    expect(resolved).toBe(true);

    jest.useRealTimers();
  });

  it("connect waits for a pending helper stop before spawning again", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    const oldChild = child;
    const nextChild = createMockChild();
    mockSpawn.mockReturnValue(nextChild);

    const disconnectPromise = adapter.disconnect();
    await flush();

    const connectPromise = adapter.connect(usbConfig);
    await flush();

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    emitExit(oldChild);
    await disconnectPromise;
    await flush();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    emitHelperLine(nextChild, { type: "ready" });
    await flush();
    emitHelperLine(nextChild, { type: "connected", product_name: "ATEM Mini Extreme" });
    await connectPromise;
  });

  it("throws when running a macro while disconnected", async () => {
    const adapter = new AtemUsbAdapter();
    await expect(adapter.runMacro(0)).rejects.toThrow("not connected");
  });
});
