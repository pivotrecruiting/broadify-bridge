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
    mockFindAvailablePort.mockResolvedValue(null);
    mockStopChildProcessGracefully.mockResolvedValue(undefined);
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
      await jest.advanceTimersByTimeAsync(2000);
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
      await jest.advanceTimersByTimeAsync(2000);
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

    it("returns error when port unavailable and no alternative found", async () => {
      mockIsPortAvailable.mockResolvedValue(false);
      mockFindAvailablePort.mockResolvedValue(null);

      const result = await bridgeProcessManager.start(baseConfig, true);

      expect(result.success).toBe(false);
      expect(result.error).toContain("no alternative port found");
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns error when process exits before health check", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess(500);
      mockSpawn.mockReturnValue(fakeProcess);

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2500);

      const result = await startPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("exited");
    });

    it("finds alternative port when requested port is busy and returns success", async () => {
      jest.useFakeTimers();
      mockIsPortAvailable.mockResolvedValue(false);
      mockFindAvailablePort.mockResolvedValue(8005);
      mockSpawn.mockReturnValue(createFakeChildProcess());

      const startPromise = bridgeProcessManager.start(baseConfig, true);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2000);
      const result = await startPromise;

      expect(result.success).toBe(true);
      expect(result.actualPort).toBe(8005);
      expect(mockFindAvailablePort).toHaveBeenCalledWith(8000, 8010, "127.0.0.1");
    });

    it("extracts EADDRNOTAVAIL from stderr when process exits early", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess(500);
      fakeProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(fakeProcess);

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      fakeProcess.stderr?.emit("data", Buffer.from("EADDRNOTAVAIL: 192.168.99.99:8000\n"));
      await jest.advanceTimersByTimeAsync(2500);

      const result = await startPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Address not available");
      expect(result.error).toContain("127.0.0.1:8000");
    });

    it("extracts ERROR from stderr when process exits early", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess(500);
      fakeProcess.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(fakeProcess);

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      fakeProcess.stderr?.emit("data", Buffer.from("ERROR: Cannot bind to port\n"));
      await jest.advanceTimersByTimeAsync(2500);

      const result = await startPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot bind to port");
    });

    it("returns generic error when process exits early with no parseable stderr", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess(500);
      mockSpawn.mockReturnValue(fakeProcess);

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2500);

      const result = await startPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe("Bridge process exited unexpectedly");
    });

    it("propagates spawn error in catch block", async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });

      const result = await bridgeProcessManager.start(baseConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain("spawn ENOENT");
    });

    it("handles non-Error in catch block", async () => {
      mockSpawn.mockImplementation(() => {
        throw "string error";
      });

      const result = await bridgeProcessManager.start(baseConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
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
      await jest.advanceTimersByTimeAsync(2000);
      await startPromise;

      const stopPromise = bridgeProcessManager.stop();
      setImmediate(() => fakeProcess.emit("exit", 0, null));
      const result = await stopPromise;

      expect(result.success).toBe(true);
      expect(mockStopChildProcessGracefully).toHaveBeenCalled();
    });

    it("returns error when stopChildProcessGracefully throws", async () => {
      jest.useFakeTimers();
      const fakeProcess = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeProcess);
      mockStopChildProcessGracefully.mockRejectedValueOnce(new Error("kill failed"));

      const startPromise = bridgeProcessManager.start(baseConfig);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2000);
      await startPromise;

      const result = await bridgeProcessManager.stop();

      expect(result.success).toBe(false);
      expect(result.error).toContain("kill failed");
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
      await jest.advanceTimersByTimeAsync(2000);
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
      await jest.advanceTimersByTimeAsync(2000);
      await startPromise;

      expect(bridgeProcessManager.getConfig()).toEqual(baseConfig);
    });
  });

});
