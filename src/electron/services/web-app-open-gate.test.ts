import {
  createWebAppOpenGate,
  WEB_APP_OPEN_RELAY_TIMEOUT_MS,
} from "./web-app-open-gate.js";

type TimerCallbackT = () => void;

/**
 * Minimal injectable timer harness: records the pending callback and delay,
 * lets a test fire or inspect it without touching the global clock.
 */
function createTimerHarness() {
  const timers = new Map<number, { cb: TimerCallbackT; ms: number }>();
  let nextHandle = 1;
  const setTimeoutFn = jest.fn((cb: TimerCallbackT, ms: number) => {
    const handle = nextHandle++;
    timers.set(handle, { cb, ms });
    return handle;
  });
  const clearTimeoutFn = jest.fn((handle: unknown) => {
    timers.delete(handle as number);
  });
  const fire = (handle: number) => {
    const entry = timers.get(handle);
    if (!entry) {
      throw new Error(`timer ${handle} is not pending`);
    }
    timers.delete(handle);
    entry.cb();
  };
  return { timers, setTimeoutFn, clearTimeoutFn, fire };
}

function createLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

const READY = { running: true, reachable: true, relayConnected: true };
const REACHABLE_NO_RELAY = {
  running: true,
  reachable: true,
  relayConnected: false,
};

describe("createWebAppOpenGate", () => {
  it("exports a 15 s default relay timeout", () => {
    expect(WEB_APP_OPEN_RELAY_TIMEOUT_MS).toBe(15_000);
  });

  it("opens the URL on the first ready status (running + reachable + relay)", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm("https://app.example.test/");
    expect(open).not.toHaveBeenCalled();

    gate.onStatus({ running: true, reachable: false });
    expect(open).not.toHaveBeenCalled();

    gate.onStatus(READY);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://app.example.test/");
    // Opening clears the fallback timer.
    expect(harness.timers.size).toBe(0);
  });

  it("does not open on reachable-without-relay before the timeout", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm("https://app.example.test/");
    gate.onStatus(REACHABLE_NO_RELAY);
    gate.onStatus(REACHABLE_NO_RELAY);

    expect(open).not.toHaveBeenCalled();
    expect(harness.timers.size).toBe(1);
  });

  it("opens after the timeout without relay and logs why", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const logger = createLogger();
    const gate = createWebAppOpenGate({
      open,
      timeoutMs: 1234,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger,
    });

    gate.arm("https://app.example.test/");
    gate.onStatus(REACHABLE_NO_RELAY);
    expect(open).not.toHaveBeenCalled();
    expect(harness.setTimeoutFn).toHaveBeenCalledWith(
      expect.any(Function),
      1234,
    );

    harness.fire(1);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://app.example.test/");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("1234"),
    );
    // A late ready status after the fallback never opens a second tab.
    gate.onStatus(READY);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("uses the default timeout when none is given", () => {
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open: jest.fn(),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
    });
    gate.arm("https://app.example.test/");
    expect(harness.setTimeoutFn).toHaveBeenCalledWith(
      expect.any(Function),
      WEB_APP_OPEN_RELAY_TIMEOUT_MS,
    );
  });

  it("disarm cancels without opening and clears the timer", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm("https://app.example.test/");
    expect(harness.timers.size).toBe(1);

    gate.disarm();

    expect(harness.clearTimeoutFn).toHaveBeenCalledWith(1);
    expect(harness.timers.size).toBe(0);
    gate.onStatus(READY);
    expect(open).not.toHaveBeenCalled();
    // disarm is idempotent.
    expect(() => gate.disarm()).not.toThrow();
  });

  it("opens only once across repeated ready statuses", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm("https://app.example.test/");
    gate.onStatus(READY);
    gate.onStatus(READY);
    gate.onStatus(READY);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("ignores statuses while not armed", () => {
    const open = jest.fn();
    const gate = createWebAppOpenGate({ open, logger: createLogger() });
    gate.onStatus(READY);
    expect(open).not.toHaveBeenCalled();
  });

  it("re-arming replaces the pending URL and restarts the timer", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm("https://first.example.test/");
    gate.arm("https://second.example.test/");

    expect(harness.clearTimeoutFn).toHaveBeenCalledWith(1);
    expect(harness.timers.size).toBe(1);

    gate.onStatus(READY);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://second.example.test/");
  });

  it("re-arming after an open allows exactly one further open", () => {
    const open = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm("https://first.example.test/");
    gate.onStatus(READY);
    gate.arm("https://second.example.test/");
    gate.onStatus(READY);
    gate.onStatus(READY);

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, "https://first.example.test/");
    expect(open).toHaveBeenNthCalledWith(2, "https://second.example.test/");
  });

  it("logs and swallows a rejected open", async () => {
    const open = jest.fn().mockRejectedValue(new Error("no browser"));
    const logger = createLogger();
    const gate = createWebAppOpenGate({ open, logger });

    gate.arm("https://app.example.test/");
    expect(() => gate.onStatus(READY)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no browser"),
    );
  });
});

/** Let the open promise and the chained afterOpen microtasks settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

describe("createWebAppOpenGate afterOpen hook", () => {
  const URL = "https://app.example.test/";

  it("runs afterOpen exactly once after the open promise resolved", async () => {
    const open = jest.fn().mockResolvedValue(undefined);
    const afterOpen = jest.fn();
    const gate = createWebAppOpenGate({ open, afterOpen, logger: createLogger() });

    gate.arm(URL);
    gate.onStatus(READY);

    expect(open).toHaveBeenCalledTimes(1);
    // The hook must wait for the browser to have actually opened.
    expect(afterOpen).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(afterOpen).toHaveBeenCalledTimes(1);

    // Repeated ready statuses neither open nor hide again.
    gate.onStatus(READY);
    await flushMicrotasks();
    expect(afterOpen).toHaveBeenCalledTimes(1);
  });

  it("runs afterOpen after a synchronous open", () => {
    const open = jest.fn();
    const afterOpen = jest.fn();
    const gate = createWebAppOpenGate({ open, afterOpen, logger: createLogger() });

    gate.arm(URL);
    gate.onStatus(READY);

    expect(afterOpen).toHaveBeenCalledTimes(1);
  });

  it("does not run afterOpen when the open rejects", async () => {
    const open = jest.fn().mockRejectedValue(new Error("no browser"));
    const afterOpen = jest.fn();
    const logger = createLogger();
    const gate = createWebAppOpenGate({ open, afterOpen, logger });

    gate.arm(URL);
    gate.onStatus(READY);
    await flushMicrotasks();

    expect(afterOpen).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no browser"),
    );
  });

  it("does not run afterOpen when the open throws synchronously", () => {
    const open = jest.fn(() => {
      throw new Error("boom");
    });
    const afterOpen = jest.fn();
    const gate = createWebAppOpenGate({ open, afterOpen, logger: createLogger() });

    gate.arm(URL);
    expect(() => gate.onStatus(READY)).not.toThrow();

    expect(afterOpen).not.toHaveBeenCalled();
  });

  it("runs afterOpen on the relay-timeout fallback open as well", async () => {
    const open = jest.fn().mockResolvedValue(undefined);
    const afterOpen = jest.fn();
    const harness = createTimerHarness();
    const gate = createWebAppOpenGate({
      open,
      afterOpen,
      timeoutMs: 50,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      logger: createLogger(),
    });

    gate.arm(URL);
    gate.onStatus(REACHABLE_NO_RELAY);
    harness.fire(1);
    await flushMicrotasks();

    // The browser opened on the fallback too, so it should be in front too.
    expect(open).toHaveBeenCalledTimes(1);
    expect(afterOpen).toHaveBeenCalledTimes(1);
  });

  it("logs and swallows an afterOpen error", async () => {
    const open = jest.fn().mockResolvedValue(undefined);
    const afterOpen = jest.fn(() => {
      throw new Error("hide failed");
    });
    const logger = createLogger();
    const gate = createWebAppOpenGate({ open, afterOpen, logger });

    gate.arm(URL);
    expect(() => gate.onStatus(READY)).not.toThrow();
    await flushMicrotasks();

    expect(afterOpen).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("hide failed"),
    );
  });
});
