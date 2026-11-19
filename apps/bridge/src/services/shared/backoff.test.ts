import {
  ReconnectScheduler,
  computeBackoffDelayMs,
} from "./backoff.js";

describe("computeBackoffDelayMs", () => {
  it("caps at maxMs", () => {
    expect(
      computeBackoffDelayMs({
        attempt: 10,
        baseMs: 1000,
        maxMs: 5000,
        jitterRatio: 0,
        random: () => 0.5,
      }),
    ).toBe(5000);
  });

  it("applies symmetric jitter within ratio", () => {
    expect(
      computeBackoffDelayMs({
        attempt: 1,
        baseMs: 1000,
        maxMs: 30_000,
        jitterRatio: 0.2,
        random: () => 0,
      }),
    ).toBe(800);
    expect(
      computeBackoffDelayMs({
        attempt: 1,
        baseMs: 1000,
        maxMs: 30_000,
        jitterRatio: 0.2,
        random: () => 1,
      }),
    ).toBe(1200);
  });

  it("is deterministic with injected random", () => {
    expect(
      computeBackoffDelayMs({
        attempt: 2,
        baseMs: 1000,
        maxMs: 30_000,
        jitterRatio: 0.2,
        random: () => 0.75,
      }),
    ).toBe(2200);
  });
});

describe("ReconnectScheduler", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("cancel() prevents the callback", async () => {
    const run = jest.fn();
    const scheduler = new ReconnectScheduler({
      baseMs: 1000,
      maxMs: 30_000,
      jitterRatio: 0,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      now: () => Date.now(),
      random: () => 0.5,
    });

    expect(scheduler.schedule(run)).toBe(true);
    expect(scheduler.isArmed()).toBe(true);
    scheduler.cancel();
    await jest.advanceTimersByTimeAsync(1000);

    expect(run).not.toHaveBeenCalled();
    expect(scheduler.isArmed()).toBe(false);
  });

  it("schedule returns false after maxAttempts", async () => {
    const scheduler = new ReconnectScheduler({
      baseMs: 1000,
      maxMs: 30_000,
      jitterRatio: 0,
      maxAttempts: 2,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      now: () => Date.now(),
      random: () => 0.5,
    });

    expect(scheduler.schedule(jest.fn())).toBe(true);
    scheduler.cancel();
    expect(scheduler.schedule(jest.fn())).toBe(true);
    scheduler.cancel();
    expect(scheduler.schedule(jest.fn())).toBe(false);
    expect(scheduler.attempt).toBe(2);
  });
});
