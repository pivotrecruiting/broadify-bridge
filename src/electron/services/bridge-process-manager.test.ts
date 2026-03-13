import { EventEmitter } from "events";
import { bridgeProcessManager } from "./bridge-process-manager.js";
import { isDev } from "../util.js";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("electron", () => ({
  app: {
    getAppPath: jest.fn().mockReturnValue("/app"),
    getVersion: jest.fn().mockReturnValue("0.13.0"),
    getPath: jest.fn().mockReturnValue("/tmp/userData"),
  },
}));

jest.mock("../util.js", () => ({
  isDev: jest.fn().mockReturnValue(true),
}));

const mockIsPortAvailable = jest.fn().mockResolvedValue(true);
const mockFindAvailablePort = jest.fn();
jest.mock("./port-checker.js", () => ({
  isPortAvailable: (...args: unknown[]) => mockIsPortAvailable(...args),
  findAvailablePort: (...args: unknown[]) => mockFindAvailablePort(...args),
}));

const mockStopChildProcessGracefully = jest.fn().mockResolvedValue(undefined);
jest.mock("./bridge-process-stop.js", () => ({
  stopChildProcessGracefully: (...args: unknown[]) =>
    mockStopChildProcessGracefully(...args),
}));

function createFakeChildProcess(exitAfterMs?: number): NodeJS.EventEmitter & {
  killed: boolean;
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  kill: jest.Mock;
} {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    killed: boolean;
    stdout: NodeJS.EventEmitter | null;
    stderr: NodeJS.EventEmitter | null;
    kill: jest.Mock;
  };
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  if (exitAfterMs != null) {
    setTimeout(() => {
      proc.killed = true;
      proc.emit("exit", 0, null);
    }, exitAfterMs);
  }
  return proc;
}

const baseConfig = { host: "127.0.0.1", port: 8000 };

describe("BridgeProcessManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPortAvailable.mockResolvedValue(true);
    (isDev as jest.Mock).mockReturnValue(true);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await bridgeProcessManager.stop();
  });

  describe("start", () => {
    it("returns success when port is available and process stays running", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeProcess);

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      const result = await startPromise;

      expect(result.success).toBe(true);
      expect(mockIsPortAvailable).toHaveBeenCalledWith(8000, "127.0.0.1");
      expect(mockSpawn).toHaveBeenCalled();
    });

    it("stops existing process before starting when already running", async () => {
      jest.useFakeTimers();
      mockSpawn.mockReturnValue(createFakeChildProcess());

      const firstPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await firstPromise;

      mockStopChildProcessGracefully.mockClear();
      bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      expect(mockStopChildProcessGracefully).toHaveBeenCalled();
    });

    it("returns error when port check fails and autoFindPort is false", async () => {
      mockIsPortAvailable.mockResolvedValue(false);

      const result = await bridgeProcessManager.start(baseConfig, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain("already in use");
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("returns success when no process is running", async () => {
      const result = await bridgeProcessManager.stop();
      expect(result.success).toBe(true);
    });

    it("calls stopChildProcessGracefully when process is running", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeProcess);

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await startPromise;

      const stopPromise = bridgeProcessManager.stop();
      setImmediate(() => fakeProcess.emit("exit", 0, null));
      const result = await stopPromise;

      expect(result.success).toBe(true);
      expect(mockStopChildProcessGracefully).toHaveBeenCalled();
    });
  });

  describe("isRunning", () => {
    it("returns false when no process has been started", () => {
      expect(bridgeProcessManager.isRunning()).toBe(false);
    });

    it("returns true after successful start", async () => {
      jest.useFakeTimers();
      mockSpawn.mockReturnValue(createFakeChildProcess());

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await startPromise;

      expect(bridgeProcessManager.isRunning()).toBe(true);
    });
  });

  describe("getConfig", () => {
    it("returns null when no process has been started", async () => {
      await bridgeProcessManager.stop();
      expect(bridgeProcessManager.getConfig()).toBeNull();
    });

    it("returns config after successful start", async () => {
      jest.useFakeTimers();
      mockSpawn.mockReturnValue(createFakeChildProcess());

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await startPromise;

      expect(bridgeProcessManager.getConfig()).toEqual(baseConfig);
    });
  });
});
