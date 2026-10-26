import { EventEmitter } from "node:events";

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("node:fs", () => ({
  __esModule: true,
  default: {
    existsSync: () => true,
  },
}));

const mockResolveElectronBinary = jest.fn(() => "/opt/electron/electron");
jest.mock("../graphics/renderer/electron-renderer-launch.js", () => ({
  resolveElectronBinary: () => mockResolveElectronBinary(),
}));

jest.mock("../../modules/vcam/vcam-helper.js", () => ({
  DEFAULT_MEETING_FRAMEBUS_NAME: "bfy-meeting-test",
}));

const mockGetBridgeContext = jest.fn(() => ({ userDataDir: "/tmp/bridge-user-data" }));
jest.mock("../bridge-context.js", () => ({
  getBridgeContext: () => mockGetBridgeContext(),
}));

import { ConferenceDisplayOutput } from "./conference-display-output.js";

type MockChildT = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
};

function createMockChild(): MockChildT {
  const child = new EventEmitter() as MockChildT;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn(() => {
    child.emit("exit", 0, null);
  });
  return child;
}

describe("ConferenceDisplayOutput", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("spawns the packaged binary in graphics-renderer aux mode with an explicit entry", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const output = new ConferenceDisplayOutput();

    const started = output.start({ matchName: "HDMI" });
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await expect(started).resolves.toBeUndefined();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [binary, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(binary).toBe("/opt/electron/electron");
    expect(args).toContain("--graphics-renderer");
    const entryFlagIndex = args.indexOf("--renderer-entry");
    expect(entryFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[entryFlagIndex + 1]).toMatch(/display-output-entry\.js$/);
    expect(options.env.BRIDGE_GRAPHICS_USER_DATA_DIR).toBe(
      "/tmp/bridge-user-data/conference-display-profile",
    );
    expect(options.env.BRIDGE_FRAMEBUS_NAME).toBe("bfy-meeting-test");
    expect(options.env.BRIDGE_DISPLAY_MATCH_NAME).toBe("HDMI");
    expect(options.env.BRIDGE_DISPLAY_PRELOAD).toMatch(/display-output-preload\.cjs$/);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();

    await output.stop();
  });

  it("falls back to a cwd-relative profile dir when the bridge context is unavailable", async () => {
    mockGetBridgeContext.mockImplementationOnce(() => {
      throw new Error("Bridge context not initialized");
    });
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const output = new ConferenceDisplayOutput();

    const started = output.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await expect(started).resolves.toBeUndefined();

    const [, , options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(options.env.BRIDGE_GRAPHICS_USER_DATA_DIR).toMatch(
      /[\\/]\.bridge-data[\\/]conference-display-profile$/,
    );

    await output.stop();
  });
});
