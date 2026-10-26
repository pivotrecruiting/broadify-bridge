import {
  createPollingDeviceWatch,
  resolvePollingIntervalMs,
} from "./polling-device-watch.js";

type FakeDeviceT = { id: string; name: string };

const flush = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Manually driven interval so tests control every poll tick. */
const createFakeInterval = () => {
  let tickFn: (() => void) | null = null;
  const handle = { unref: jest.fn() };
  const setIntervalFn = jest.fn((fn: () => void) => {
    tickFn = fn;
    return handle;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = jest.fn() as unknown as typeof clearInterval;
  return {
    handle,
    setIntervalFn,
    clearIntervalFn,
    tick: async (): Promise<void> => {
      tickFn?.();
      await flush();
    },
  };
};

const createLogger = () => ({
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
});

const fingerprint = (devices: FakeDeviceT[]): string =>
  devices
    .map((device) => `${device.id}|${device.name}`)
    .sort()
    .join(";");

const A: FakeDeviceT = { id: "a", name: "Display A" };
const B: FakeDeviceT = { id: "b", name: "Display B" };

describe("createPollingDeviceWatch", () => {
  it("establishes a baseline on subscribe without emitting and emits only on fingerprint change", async () => {
    const timers = createFakeInterval();
    const logger = createLogger();
    const detect = jest
      .fn<Promise<FakeDeviceT[]>, []>()
      .mockResolvedValueOnce([A])
      .mockResolvedValueOnce([A])
      .mockResolvedValueOnce([B, A])
      .mockResolvedValueOnce([A, B]);
    const watch = createPollingDeviceWatch<FakeDeviceT>({
      detect,
      intervalMs: 15_000,
      fingerprint,
      logger,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const callback = jest.fn();

    watch(callback);
    await flush();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(timers.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      15_000,
    );
    expect(timers.handle.unref).toHaveBeenCalled();

    await timers.tick();
    expect(callback).not.toHaveBeenCalled();

    await timers.tick();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([B, A]);

    // Same set in a different order: fingerprint is order-independent.
    await timers.tick();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while a detect is still in flight", async () => {
    const timers = createFakeInterval();
    let resolveFirst: ((devices: FakeDeviceT[]) => void) | null = null;
    const detect = jest.fn<Promise<FakeDeviceT[]>, []>(
      () =>
        new Promise<FakeDeviceT[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const watch = createPollingDeviceWatch<FakeDeviceT>({
      detect,
      intervalMs: 15_000,
      fingerprint,
      logger: createLogger(),
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const callback = jest.fn();

    watch(callback);
    await flush();
    expect(detect).toHaveBeenCalledTimes(1);

    await timers.tick();
    await timers.tick();
    expect(detect).toHaveBeenCalledTimes(1);

    resolveFirst?.([A]);
    await flush();
    await timers.tick();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe clears the interval and stops polling and emitting", async () => {
    const timers = createFakeInterval();
    let resolvePending: ((devices: FakeDeviceT[]) => void) | null = null;
    const detect = jest
      .fn<Promise<FakeDeviceT[]>, []>()
      .mockResolvedValueOnce([A])
      .mockImplementationOnce(
        () =>
          new Promise<FakeDeviceT[]>((resolve) => {
            resolvePending = resolve;
          }),
      )
      .mockResolvedValue([B]);
    const watch = createPollingDeviceWatch<FakeDeviceT>({
      detect,
      intervalMs: 15_000,
      fingerprint,
      logger: createLogger(),
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const callback = jest.fn();

    const unsubscribe = watch(callback);
    await flush();
    await timers.tick();
    expect(detect).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(timers.clearIntervalFn).toHaveBeenCalledWith(timers.handle);

    // A detect that resolves after unsubscribe must not emit.
    resolvePending?.([B]);
    await flush();
    expect(callback).not.toHaveBeenCalled();

    // A stray tick after unsubscribe must not poll.
    await timers.tick();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("logs a detect failure once per failure series and keeps polling", async () => {
    const timers = createFakeInterval();
    const logger = createLogger();
    const detect = jest
      .fn<Promise<FakeDeviceT[]>, []>()
      .mockResolvedValueOnce([A])
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockRejectedValueOnce(new Error("boom 2"))
      .mockResolvedValueOnce([A, B])
      .mockRejectedValueOnce(new Error("boom 3"));
    const watch = createPollingDeviceWatch<FakeDeviceT>({
      detect,
      intervalMs: 15_000,
      fingerprint,
      label: "TestWatch",
      logger,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const callback = jest.fn();

    watch(callback);
    await flush();

    await timers.tick();
    await timers.tick();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("boom 1"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[TestWatch]"),
    );

    // Recovery: polling continued and the change after the failures is emitted.
    await timers.tick();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([A, B]);

    // A new failure series warns again.
    await timers.tick();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("boom 3"),
    );
  });

  it("does not emit when the first successful poll after failures matches the baseline", async () => {
    const timers = createFakeInterval();
    const detect = jest
      .fn<Promise<FakeDeviceT[]>, []>()
      .mockResolvedValueOnce([A])
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([A]);
    const watch = createPollingDeviceWatch<FakeDeviceT>({
      detect,
      intervalMs: 15_000,
      fingerprint,
      logger: createLogger(),
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const callback = jest.fn();

    watch(callback);
    await flush();
    await timers.tick();
    await timers.tick();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("resolvePollingIntervalMs", () => {
  const resolve = (envValue: string | undefined) => {
    const logger = { warn: jest.fn() };
    const value = resolvePollingIntervalMs({
      envName: "BRIDGE_DISPLAY_WATCH_INTERVAL_MS",
      envValue,
      defaultMs: 15_000,
      minMs: 2_000,
      logger,
    });
    return { value, logger };
  };

  it("returns the default when the variable is unset or blank", () => {
    expect(resolve(undefined)).toMatchObject({ value: 15_000 });
    const blank = resolve("   ");
    expect(blank.value).toBe(15_000);
    expect(blank.logger.warn).not.toHaveBeenCalled();
  });

  it("accepts a valid integer at or above the minimum", () => {
    expect(resolve("30000").value).toBe(30_000);
    expect(resolve(" 2000 ").value).toBe(2_000);
  });

  it("falls back to the default and warns on invalid values", () => {
    for (const raw of ["500", "abc", "1e4", "-3000", "15000.5", "0"]) {
      const { value, logger } = resolve(raw);
      expect(value).toBe(15_000);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("BRIDGE_DISPLAY_WATCH_INTERVAL_MS"),
      );
    }
  });
});
