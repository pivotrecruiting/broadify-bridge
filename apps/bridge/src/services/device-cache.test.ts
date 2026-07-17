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
        type: type === "display" ? "hdmi" : "sdi",
        role: "video",
        direction: "output",
        status: { available: true },
        capabilities: { formats: [] },
      },
    ],
  }) as any;

const success = (moduleName: string, devices: any[]) => ({
  moduleName,
  status: "success" as const,
  devices,
  durationMs: 1,
});

describe("DeviceCache", () => {
  const createDeps = () => {
    let now = 1_000;
    let watchCallback: ((moduleName: string) => void) | undefined;
    const unsubscribe = jest.fn();
    const detectModules = jest.fn(async (moduleNames?: readonly string[]) =>
      (moduleNames ?? ["decklink"]).map((moduleName) =>
        success(
          moduleName,
          moduleName === "decklink" ? [createDevice("deck-1")] : [],
        ),
      ),
    );
    const moduleRegistry = {
      getModuleNames: jest.fn(() => ["decklink"]),
      detectModules,
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
      detectModules,
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
    expect(second).toEqual(first);
    expect(deps.detectModules).toHaveBeenCalledTimes(1);
    expect(cache.isFresh()).toBe(true);
  });

  it("logs debug when using cached results within TTL", async () => {
    const deps = createDeps();
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      cacheTtlMs: 1000,
    });

    await cache.getDevices();
    deps.setNow(1_100);
    await cache.getDevices();

    expect(deps.logger.debug).toHaveBeenCalledWith(
      "[Devices] Using cached results (1 devices)",
    );
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
    expect(deps.detectModules).toHaveBeenCalledTimes(1);
  });

  it("waits for ongoing detection instead of starting a second one", async () => {
    const deps = createDeps();
    let releaseDetection: (() => void) | undefined;
    const detectionGate = new Promise<void>((resolve) => {
      releaseDetection = resolve;
    });
    const detectedDevices = [createDevice("deck-1")];

    deps.detectModules.mockImplementation(async () => {
      await detectionGate;
      return [success("decklink", detectedDevices)];
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
    expect(deps.detectModules).toHaveBeenCalledTimes(1);
  });

  it("detects only requested output modules", async () => {
    const deps = createDeps();
    deps.moduleRegistry.getModuleNames.mockReturnValue([
      "usb-capture",
      "display",
      "decklink",
    ]);
    deps.detectModules.mockImplementation(async (moduleNames) =>
      (moduleNames ?? []).map((moduleName) =>
        success(
          moduleName,
          moduleName === "display"
            ? [createDevice("display-1", "display")]
            : [],
        ),
      ),
    );
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
    });

    const devices = await cache.getDevices(false, ["display", "decklink"]);

    expect(deps.detectModules).toHaveBeenCalledWith(["display", "decklink"]);
    expect(devices).toEqual([expect.objectContaining({ id: "display-1" })]);
  });

  it("preserves a previously detected display after a timeout", async () => {
    const deps = createDeps();
    deps.moduleRegistry.getModuleNames.mockReturnValue(["display"]);
    deps.detectModules
      .mockResolvedValueOnce([
        success("display", [createDevice("display-1", "display")]),
      ])
      .mockResolvedValueOnce([
        {
          moduleName: "display",
          status: "timeout",
          devices: [],
          durationMs: 2_000,
          errorCode: "detection_timeout",
        },
      ]);
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      refreshRateLimitMs: 0,
    });

    await cache.getDevices();
    deps.setNow(4_000);
    const refreshed = await cache.getDevices(true);

    expect(refreshed).toEqual([expect.objectContaining({ id: "display-1" })]);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("preserving 1 cached device"),
    );
  });

  it("clears a module after a successful empty detection", async () => {
    const deps = createDeps();
    deps.moduleRegistry.getModuleNames.mockReturnValue(["display"]);
    deps.detectModules
      .mockResolvedValueOnce([
        success("display", [createDevice("display-1", "display")]),
      ])
      .mockResolvedValueOnce([success("display", [])]);
    const cache = new DeviceCache({
      moduleRegistry: deps.moduleRegistry as any,
      getLogger: () => deps.logger,
      now: () => deps.getNow(),
      wait: async () => undefined,
      refreshRateLimitMs: 0,
    });

    await cache.getDevices();
    deps.setNow(4_000);

    await expect(cache.getDevices(true)).resolves.toEqual([]);
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
    expect(deps.detectModules).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(250);

    expect(deps.detectModules).toHaveBeenCalledTimes(1);
    expect(deps.detectModules).toHaveBeenCalledWith(["decklink"]);
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
    expect(deps.detectModules).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
