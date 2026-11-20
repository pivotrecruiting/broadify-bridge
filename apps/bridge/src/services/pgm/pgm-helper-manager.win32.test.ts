import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockSpawn = jest.fn();
const mockExecFileSync = jest.fn();
const mockWarn = jest.fn();

jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// helper-launch reads the platform from node:os; the manager gets it injected.
jest.mock("node:os", () => ({
  ...jest.requireActual("node:os"),
  platform: () => "win32",
}));

jest.mock("../bridge-context.js", () => ({
  getBridgeContext: () => ({ userDataDir: "/tmp/broadify-pgm-win32-test", logger: { info() {}, warn: mockWarn, error() {}, debug() {} }, publishBridgeEvent: undefined }),
}));

import { idlePgmStatus, PgmHelperManager } from "./pgm-helper-manager.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function fakeClient() {
  return {
    ping: jest.fn(async () => true),
    status: jest.fn(async () => idlePgmStatus(true)),
    inputsList: jest.fn(async () => ({ inputs: [], camera_permission: "authorized" })),
    shutdown: jest.fn(async () => undefined),
  };
}

describe("PGM helper manager on Windows", () => {
  const savedHelperPath = process.env.BRIDGE_PGM_HELPER_PATH;
  let helperPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "pgm-win32-"));
    helperPath = join(dir, "pgm-helper.exe");
    writeFileSync(helperPath, "");
    process.env.BRIDGE_PGM_HELPER_PATH = helperPath;
    mockSpawn.mockReset();
    mockExecFileSync.mockReset();
    mockWarn.mockReset();
  });

  afterEach(() => {
    if (savedHelperPath === undefined) {
      delete process.env.BRIDGE_PGM_HELPER_PATH;
    } else {
      process.env.BRIDGE_PGM_HELPER_PATH = savedHelperPath;
    }
  });

  const manager = (env: NodeJS.ProcessEnv, client = fakeClient()) =>
    new PgmHelperManager({ env, platform: "win32", userDataDir: () => "/tmp/broadify-pgm-win32-test", createClient: () => client as never });

  it("starts the helper directly with windowsHide, a named pipe and no codesign check when BRIDGE_PGM_WINDOWS=1", async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);
    const client = fakeClient();
    const m = manager({ BRIDGE_PGM_WINDOWS: "1" }, client);

    await expect(m.listInputs()).resolves.toEqual({ inputs: [], camera_permission: "authorized" });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; stdio: unknown; windowsHide: boolean }];
    expect(command).toBe(helperPath);
    expect(args.slice(0, 4)).toEqual(["--run", "--parent-pid", String(process.pid), "--control-socket"]);
    expect(args[4]).toMatch(/^\\\\\.\\pipe\\broadify-pgm-/);
    expect(options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    expect(options.env).toMatchObject({ BRIDGE_PGM_WINDOWS: "1", PGM_CONTROL_SOCKET: args[4] });
    // No codesign on Windows, and no warning about a code signature.
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalledWith(expect.stringContaining("code signature"));
    expect(client.ping).toHaveBeenCalled();
    expect(m.isRunning()).toBe(true);

    // Events arrive on stdout (no Launch Services, no event-log tail).
    const running = { ...idlePgmStatus(true), state: "running" };
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "pgm_status", status: running })}\n`));
    expect(m.getStatus().state).toBe("running");

    await m.stop();
    expect(client.shutdown).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("never starts the helper without BRIDGE_PGM_WINDOWS, not even to restore a saved source", async () => {
    const m = manager({});
    await expect(m.listInputs()).rejects.toMatchObject({ code: "pgm_unsupported_bridge", message: "Windows preview not enabled on this bridge." });
    await expect(m.selectSource("uvc:k", "auto")).rejects.toMatchObject({ code: "pgm_unsupported_bridge" });
    // A source saved while the switch was on stays saved, but the boot restore leaves the helper alone.
    Object.assign(m as unknown as Record<string, unknown>, { sourceLoaded: true, source: { version: 1, input: { kind: "uvc", stable_key: "k", display_name: "ATEM Mini" }, profile: "auto" } });
    await m.restoreOnBoot();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(m.getSource().input).toMatchObject({ stable_key: "k" });
    expect(m.getStatus()).toMatchObject({ state: "idle", last_error: null });
  });
});
