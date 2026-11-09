import { EventEmitter } from "node:events";
import { HelperProcessSession } from "./helper-process-session.js";

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createMockChild(): EventEmitter & {
  stdin: EventEmitter & { writable: boolean; write: jest.Mock; end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { writable: boolean; write: jest.Mock; end: jest.Mock };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn((signal?: NodeJS.Signals) => {
    child.exitCode = signal === "SIGKILL" ? 137 : 0;
    child.signalCode = signal ?? null;
    child.emit("exit", child.exitCode, child.signalCode);
  });
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

const createSession = (overrides: Partial<ConstructorParameters<typeof HelperProcessSession>[0]> = {}) =>
  new HelperProcessSession({
    label: "TestHelper",
    helperPath: "/tmp/helper",
    args: ["--run"],
    env: {},
    stdin: "pipe",
    readyTimeoutMs: 100,
    stderrRingSize: 2,
    stopStrategy: { gracefulMs: 25, forceMs: 25 },
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    ...overrides,
  });

const createLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

describe("HelperProcessSession", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves on ready", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession();

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));

    await expect(started).resolves.toBeUndefined();
  });

  it("rejects with last stderr lines when the helper exits before ready", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession();

    const started = session.start();
    child.stderr.emit("data", Buffer.from("first\nsecond\nthird\n"));
    child.exitCode = 1;
    child.emit("exit", 1, null);

    await expect(started).rejects.toThrow("second");
    await expect(started).rejects.toThrow("third");
  });

  describe("stderr", () => {
    it("logs every stderr line at warn by default and keeps the ring buffer", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = createLogger();
      const session = createSession({ logger, stderrRingSize: 5 });

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit("data", Buffer.from("one\r\ntwo\n"));

      expect(logger.warn).toHaveBeenCalledWith("[TestHelper] one");
      expect(logger.warn).toHaveBeenCalledWith("[TestHelper] two");
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("logs at error when stderrLogLevel is error", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = createLogger();
      const session = createSession({ logger, stderrLogLevel: "error" });

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit("data", Buffer.from("boom\n"));

      expect(logger.error).toHaveBeenCalledWith("[TestHelper] boom");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("joins a line split across chunks before logging it", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = createLogger();
      const session = createSession({ logger });

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit(
        "data",
        Buffer.from("Playback stats: completed=815 late=0 dropped="),
      );
      expect(logger.warn).not.toHaveBeenCalled();

      child.stderr.emit("data", Buffer.from("0\nnext"));
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "[TestHelper] Playback stats: completed=815 late=0 dropped=0",
      );

      child.stderr.emit("data", Buffer.from(" line\n"));
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith("[TestHelper] next line");
    });

    it("flushes a trailing partial line on exit and includes it in the exited event", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = createLogger();
      const session = createSession({ logger });
      const lifecycle = jest.fn();
      session.onLifecycle(lifecycle);

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit("data", Buffer.from("device lost"));
      expect(logger.warn).not.toHaveBeenCalled();

      child.exitCode = 2;
      child.emit("exit", 2, null);

      expect(logger.warn).toHaveBeenCalledWith("[TestHelper] device lost");
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ type: "exited", lastStderr: ["device lost"] }),
      );
    });

    it("flushes a trailing partial line when the stderr pipe ends", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = createLogger();
      const session = createSession({ logger });

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit("data", Buffer.from("tail without newline"));
      child.stderr.emit("end");

      expect(logger.warn).toHaveBeenCalledWith("[TestHelper] tail without newline");
    });

    it("includes a partial line in the failure context when the helper exits before ready", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const session = createSession();

      const started = session.start();
      child.stderr.emit("data", Buffer.from("FrameBus open failed: ENOENT"));
      child.exitCode = 1;
      child.emit("exit", 1, null);

      await expect(started).rejects.toThrow("FrameBus open failed: ENOENT");
    });

    it("routes lines through stderrLineLevel when provided", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = createLogger();
      const session = createSession({
        logger,
        stderrLogLevel: "error",
        stderrLineLevel: (line) => {
          if (line.startsWith("stats")) return "debug";
          if (line.startsWith("note")) return "info";
          if (line.startsWith("fatal")) return "error";
          return "warn";
        },
      });

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit(
        "data",
        Buffer.from("stats 1\nnote 2\nfatal 3\nsomething else\n"),
      );

      expect(logger.debug).toHaveBeenCalledWith("[TestHelper] stats 1");
      expect(logger.info).toHaveBeenCalledWith("[TestHelper] note 2");
      expect(logger.error).toHaveBeenCalledWith("[TestHelper] fatal 3");
      expect(logger.warn).toHaveBeenCalledWith("[TestHelper] something else");
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("keeps classified lines in the ring buffer regardless of level", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const session = createSession({
        stderrRingSize: 5,
        stderrLineLevel: () => "debug",
      });
      const lifecycle = jest.fn();
      session.onLifecycle(lifecycle);

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      child.stderr.emit("data", Buffer.from("quiet 1\nquiet 2\n"));
      child.exitCode = 3;
      child.emit("exit", 3, null);

      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ lastStderr: ["quiet 1", "quiet 2"] }),
      );
    });

    it("drops debug-classified lines when the logger has no debug method", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const session = createSession({ logger, stderrLineLevel: () => "debug" });

      const started = session.start();
      child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await started;
      expect(() => child.stderr.emit("data", Buffer.from("stats\n"))).not.toThrow();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it("rejects after readyTimeoutMs and kills the child", async () => {
    jest.useFakeTimers();
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession({ readyTimeoutMs: 100 });

    const started = expect(session.start()).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(100);

    await started;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("emits exited with requested=false after ready", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession();
    const lifecycle = jest.fn();
    session.onLifecycle(lifecycle);

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await started;
    child.stderr.emit("data", Buffer.from("lost device\n"));
    child.exitCode = 2;
    child.emit("exit", 2, null);

    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "exited",
        requested: false,
        code: 2,
        lastStderr: ["lost device"],
      }),
    );
  });

  it("emits no exited when stop requested it", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession();
    const lifecycle = jest.fn();
    session.onLifecycle(lifecycle);

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await started;
    const stopped = session.stop();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopped;

    expect(lifecycle).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "exited" }),
    );
  });

  it("attaches fatal code to exited", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession();
    const lifecycle = jest.fn();
    session.onLifecycle(lifecycle);

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await started;
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"fatal","code":"device_lost","message":"gone"}\n'),
    );
    child.exitCode = 1;
    child.emit("exit", 1, null);

    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "exited",
        fatal: { code: "device_lost", message: "gone" },
      }),
    );
  });

  it("parses helperVersion", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const session = createSession();

    const started = session.start();
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"ready","helperVersion":"1.2.3"}\n'),
    );
    await started;

    expect(session.helperVersion).toBe("1.2.3");
  });

  it("ignores unknown message types", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const logger = createLogger();
    const session = createSession({ logger });

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"new_future_event"}\n'));
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));

    await expect(started).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("new_future_event"),
    );
  });
  it("tolerates an EPIPE error on stdin after start without throwing", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const logger = createLogger();
    const session = createSession({ logger });

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await started;

    expect(() =>
      child.stdin.emit(
        "error",
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      ),
    ).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("EPIPE"));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("EPIPE"));
  });

  it("stop resolves even when the shutdown write to stdin throws", async () => {
    const child = createMockChild();
    child.stdin.write.mockImplementation(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    child.stdin.end.mockImplementation(() => {
      throw Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
    });
    mockSpawn.mockReturnValue(child);
    const session = createSession({
      stopStrategy: { shutdownHeader: Buffer.from("quit"), gracefulMs: 25, forceMs: 25 },
    });

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await started;

    await expect(session.stop()).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
