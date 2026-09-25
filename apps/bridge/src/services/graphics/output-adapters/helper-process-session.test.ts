import { EventEmitter } from "node:events";
import { HelperProcessSession } from "./helper-process-session.js";

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createMockChild(): EventEmitter & {
  stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = Object.assign(new EventEmitter(), {
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
      warn: jest.fn(),
      error: jest.fn(),
    },
    ...overrides,
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
    const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const session = createSession({ logger });

    const started = session.start();
    child.stdout.emit("data", Buffer.from('{"type":"new_future_event"}\n'));
    child.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));

    await expect(started).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("new_future_event"),
    );
  });
});
