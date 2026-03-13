import { DeviceCache } from "./device-cache.js";

const createDevice = (id: string, type: string = "decklink") =>
  ({
    id,
    displayName: id,
    type,
    status: {
      present: true,
      ready: true,
      inUse: false,
      lastSeen: Date.now(),
    },
    ports: [
      {
        id: `${id}-port`,
        displayName: `${id} port`,
        type: "sdi",
        role: "fill",
        direction: "output",
        status: {
          available: true,
        },
        capabilities: {
          formats: [],
        },
      },
    ],
  }) as any;

describe("DeviceCache", () => {
  const createDeps = () => {
    let now = 1_000;
    let watchCallback: ((moduleName: string) => void) | undefined;
    const unsubscribe = jest.fn();
    const detectAll = jest.fn(async () => [createDevice("deck-1")]);
    const moduleRegistry = {
      getModuleNames: jest.fn(() => ["decklink"]),
      detectAll,
      watchAll: jest.fn((callback: (moduleName: string) => void) => {
        watchCallback = callback;
        return unsubscribe;
      }),
    };
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
    };

    return {
      moduleRegistry,
      logger,
      detectAll,
      unsubscribe,
      getNow: () => now,
      setNow: (value: number) => {
        now = value;
      },
      triggerWatch: (moduleName: string) => {
        watchCallback?.(moduleName);
      },
    };
  };

  it("returns cached devices within TTL without re-detecting", async () => {
    const deps = createDeps();
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      cacheTtlMs: 1000,
    });

    const first = await cache.getDevices();
    deps.setNow(1_500);
    const second = await cache.getDevices();

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "deck-1", type: "decklink" });
    expect(second).toBe(first);
    expect(deps.detectAll).toHaveBeenCalledTimes(1);
    expect(cache.isFresh()).toBe(true);
  });

  it("enforces force-refresh rate limit", async () => {
    const deps = createDeps();
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      refreshRateLimitMs: 2000,
    });

    await cache.getDevices();
    deps.setNow(2_000);

    await expect(cache.getDevices(true)).rejects.toThrow("Rate limit exceeded");
    expect(deps.detectAll).toHaveBeenCalledTimes(1);
  });

  it("waits for ongoing detection instead of starting a second one", async () => {
    const deps = createDeps();
    let releaseDetection: (() => void) | undefined;
    const detectionGate = new Promise<void>((resolve) => {
      releaseDetection = resolve;
    });
    const detectedDevices = [createDevice("deck-1")];

    deps.detectAll.mockImplementation(async () => {
      await detectionGate;
      return detectedDevices;
    });

    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: () => detectionGate.then(() => undefined),
    });

    const first = cache.getDevices();
    const second = cache.getDevices();
    releaseDetection?.();

    await expect(first).resolves.toEqual(detectedDevices);
    await expect(second).resolves.toEqual(detectedDevices);
    expect(deps.detectAll).toHaveBeenCalledTimes(1);
  });

  it("debounces watch-triggered refreshes", async () => {
    jest.useFakeTimers();
    const deps = createDeps();
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      watchDebounceMs: 250,
    });

    cache.initializeWatchers();
    deps.triggerWatch("decklink");
    deps.triggerWatch("decklink");

    expect(deps.moduleRegistry.watchAll).toHaveBeenCalledTimes(1);
    expect(deps.detectAll).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(250);

    expect(deps.detectAll).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it("clear resets cache, clears pending watch timer, and unsubscribes", async () => {
    jest.useFakeTimers();
    const deps = createDeps();
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      watchDebounceMs: 250,
    });

    await cache.getDevices();
    cache.initializeWatchers();
    deps.triggerWatch("decklink");

    cache.clear();
    await jest.advanceTimersByTimeAsync(250);

    expect(cache.getCachedDevices()).toEqual([]);
    expect(cache.isFresh()).toBe(false);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(deps.detectAll).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
