import { EventEmitter } from "events";
import type { ChildProcess } from "node:child_process";
import {
  awaitChildExit,
  stopChildProcessWithEscalation,
} from "./child-process-exit.js";

type MockChildT = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: jest.Mock;
};

function createMockChild(): MockChildT {
  const child = new EventEmitter() as MockChildT;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn();
  return child;
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

describe("child-process-exit", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves immediately for an exited child", async () => {
    const child = createMockChild();
    child.exitCode = 0;

    await expect(awaitChildExit(child as ChildProcess)).resolves.toBeUndefined();
  });

  it("runs shutdown→SIGTERM→SIGKILL escalation with the given delays", async () => {
    jest.useFakeTimers();
    const child = createMockChild();
    const requestShutdown = jest.fn();

    let resolved = false;
    const stopPromise = stopChildProcessWithEscalation(child as ChildProcess, {
      requestShutdown,
      gracefulMs: 4000,
      forceMs: 2000,
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(4000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(resolved).toBe(false);

    await jest.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it("clears timers when the child exits early", async () => {
    jest.useFakeTimers();
    const child = createMockChild();
    const clearTimeoutFn = jest.fn(clearTimeout);

    const stopPromise = stopChildProcessWithEscalation(child as ChildProcess, {
      requestShutdown: jest.fn(),
      gracefulMs: 4000,
      forceMs: 2000,
      clearTimeoutFn,
    });

    emitExit(child);
    await stopPromise;

    expect(clearTimeoutFn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(6000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
