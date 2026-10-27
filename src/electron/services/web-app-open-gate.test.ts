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
