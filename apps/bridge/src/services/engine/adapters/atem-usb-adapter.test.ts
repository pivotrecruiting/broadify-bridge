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
};

function createMockChild(): MockChildT {
  const child = new EventEmitter() as MockChildT;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: jest.fn().mockReturnValue(true) };
  child.kill = jest.fn();
  return child;
}

function emitHelperLine(child: MockChildT, event: Record<string, unknown>): void {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
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

  async function connectAdapter(adapter: AtemUsbAdapter): Promise<void> {
    const connectPromise = adapter.connect(usbConfig);
    await flush();
    emitHelperLine(child, { type: "ready" });
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

  it("stops a macro through the helper", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    await adapter.runMacro(7);
    emitHelperLine(child, { type: "macro_state", status: "running", loop: false, index: 7 });
    await flush();
    await adapter.stopMacro(7);

    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"macro_stop"}\n');
  });

  it("marks the state disconnected when the switcher drops off USB", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    emitHelperLine(child, { type: "disconnected" });
    await flush();
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("sends shutdown on disconnect and resets state", async () => {
    const adapter = new AtemUsbAdapter();
    await connectAdapter(adapter);

    await adapter.disconnect();

    expect(child.stdin.write).toHaveBeenCalledWith('{"command":"shutdown"}\n');
    expect(adapter.getStatus()).toBe("disconnected");
    expect(adapter.getMacros()).toEqual([]);
    expect(adapter.getState().transport).toBeUndefined();
  });

  it("throws when running a macro while disconnected", async () => {
    const adapter = new AtemUsbAdapter();
    await expect(adapter.runMacro(0)).rejects.toThrow("not connected");
  });
});
