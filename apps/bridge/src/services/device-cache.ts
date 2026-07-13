import type { DeviceDescriptorT } from "@broadify/protocol";
import { moduleRegistry } from "../modules/module-registry.js";
import { getBridgeContext } from "./bridge-context.js";

type DeviceCacheLoggerT = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
};

type DeviceCacheDepsT = {
  moduleRegistry: Pick<
    typeof moduleRegistry,
    "getModuleNames" | "detectModules" | "watchAll"
  >;
  getLogger: () => DeviceCacheLoggerT;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
};

type DeviceCacheOptionsT = Partial<DeviceCacheDepsT> & {
  cacheTtlMs?: number;
  refreshRateLimitMs?: number;
  watchDebounceMs?: number;
};

const defaultDeps: DeviceCacheDepsT = {
  moduleRegistry,
  getLogger: () => getBridgeContext().logger,
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
};

/**
 * Device cache service.
 *
 * Manages caching of device detection results with refresh logic.
 */
export class DeviceCache {
  private cachedDevicesByModule = new Map<string, DeviceDescriptorT[]>();
  private lastDetectionTimeByModule = new Map<string, number>();
  private lastDetectionTime = 0;
  private detectionInProgress = false;
  private watchInitialized = false;
  private watchUnsubscribe: (() => void) | undefined;
  private watchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingWatchModules = new Set<string>();
  private deps: DeviceCacheDepsT;

  /**
   * Cache TTL in milliseconds
   */
  private readonly cacheTtlMs: number;

  /**
   * Rate limit for manual refreshes in milliseconds
   */
  private readonly refreshRateLimitMs: number;
  private readonly watchDebounceMs: number;

  constructor(options: DeviceCacheOptionsT = {}) {
    this.deps = {
      ...defaultDeps,
      ...options,
    };
    this.cacheTtlMs = options.cacheTtlMs ?? 1000;
    this.refreshRateLimitMs = options.refreshRateLimitMs ?? 2000;
    this.watchDebounceMs = options.watchDebounceMs ?? 250;
  }

  /**
   * Get cached devices or perform detection if cache expired.
   *
   * @param forceRefresh Force immediate detection (rate-limited).
   * @returns Array of detected devices.
   */
  async getDevices(
    forceRefresh = false,
    moduleNames?: readonly string[],
  ): Promise<DeviceDescriptorT[]> {
    const logger = this.deps.getLogger();
    const logDebug = logger.debug?.bind(logger);
    const now = this.deps.now();
    const availableModuleNames = this.deps.moduleRegistry.getModuleNames();
    const requestedModuleNames = moduleNames
      ? availableModuleNames.filter((name) => moduleNames.includes(name))
      : availableModuleNames;
    const modulesNeedingDetection = requestedModuleNames.filter((name) => {
      const lastModuleDetection = this.lastDetectionTimeByModule.get(name) ?? 0;
      return (
        forceRefresh ||
        !this.cachedDevicesByModule.has(name) ||
        now - lastModuleDetection >= this.cacheTtlMs
      );
    });

    if (modulesNeedingDetection.length === 0) {
      const cachedDevices = this.collectCachedDevices(requestedModuleNames);
      logDebug?.(
        `[Devices] Using cached results (${cachedDevices.length} devices)`,
      );
      return cachedDevices;
    }

    // Check rate limit for manual refresh
    if (forceRefresh) {
      const timeSinceLastRefresh = now - this.lastDetectionTime;
      if (timeSinceLastRefresh < this.refreshRateLimitMs) {
        throw new Error(
          `Rate limit exceeded. Please wait ${Math.ceil(
            (this.refreshRateLimitMs - timeSinceLastRefresh) / 1000
          )} seconds`
        );
      }
    }

    // Prevent concurrent detection
    if (this.detectionInProgress) {
      // Wait for ongoing detection
      logDebug?.("[Devices] Detection already in progress, waiting...");
      while (this.detectionInProgress) {
        await this.deps.wait(50);
      }
      return this.getDevices(false, requestedModuleNames);
    }

    // Perform detection
    this.detectionInProgress = true;
    try {
      logDebug?.(
        `[Devices] Detecting devices (forceRefresh=${forceRefresh}) [modules: ${modulesNeedingDetection.join(", ") || "none"}]`,
      );
      const results = await this.deps.moduleRegistry.detectModules(
        modulesNeedingDetection,
      );
      this.lastDetectionTime = this.deps.now();
      for (const result of results) {
        this.lastDetectionTimeByModule.set(
          result.moduleName,
          this.lastDetectionTime,
        );
        if (result.status === "success") {
          this.cachedDevicesByModule.set(result.moduleName, result.devices);
          continue;
        }
        const cachedCount =
          this.cachedDevicesByModule.get(result.moduleName)?.length ?? 0;
        logger.warn(
          `[Devices] ${result.moduleName} detection ${result.status}; preserving ${cachedCount} cached device(s)`,
        );
      }

      const cachedDevices = this.collectCachedDevices(requestedModuleNames);

      const typeCounts = cachedDevices.reduce<Record<string, number>>(
        (acc, device) => {
          acc[device.type] = (acc[device.type] || 0) + 1;
          return acc;
        },
        {}
      );
      const totalPorts = cachedDevices.reduce(
        (sum, device) => sum + device.ports.length,
        0
      );

      logDebug?.(
        `[Devices] Detection complete: ${cachedDevices.length} devices, ${totalPorts} ports (by type: ${JSON.stringify(
          typeCounts
        )})`
      );

      if (cachedDevices.length === 0) {
        logger.warn(
          "[Devices] No devices detected. Check device drivers and connections."
        );
      }

      return cachedDevices;
    } finally {
      this.detectionInProgress = false;
    }
  }

  /**
   * Initialize device watchers for hotplug updates.
   *
   * Note: Watchers are debounced to avoid heavy detection bursts.
   */
  initializeWatchers(): void {
    if (this.watchInitialized) {
      return;
    }

    this.watchInitialized = true;
    const logger = this.deps.getLogger();
    const logDebug = logger.debug?.bind(logger);
    this.watchUnsubscribe = this.deps.moduleRegistry.watchAll((moduleName) => {
      logDebug?.(`[Devices] Watch update from ${moduleName}`);
      this.scheduleWatchRefresh(moduleName);
    });
  }

  /**
   * Schedule a debounced refresh when a watch event is received.
   */
  private scheduleWatchRefresh(moduleName: string): void {
    this.pendingWatchModules.add(moduleName);
    if (this.watchRefreshTimer) {
      return;
    }

    this.watchRefreshTimer = this.deps.setTimeoutFn(async () => {
      this.watchRefreshTimer = undefined;
      const logger = this.deps.getLogger();
      const logDebug = logger.debug?.bind(logger);
      if (this.detectionInProgress) {
        logDebug?.("[Devices] Detection in progress, deferring watch refresh");
        this.scheduleWatchRefresh(moduleName);
        return;
      }

      this.detectionInProgress = true;
      try {
        logDebug?.("[Devices] Refreshing cache from watch event");
        const pendingModules = Array.from(this.pendingWatchModules);
        this.pendingWatchModules.clear();
        const results = await this.deps.moduleRegistry.detectModules(
          pendingModules,
        );
        const detectedAt = this.deps.now();
        for (const result of results) {
          this.lastDetectionTimeByModule.set(result.moduleName, detectedAt);
          if (result.status === "success") {
            this.cachedDevicesByModule.set(result.moduleName, result.devices);
          } else {
            logger.warn(
              `[Devices] Watch refresh for ${result.moduleName} ${result.status}; preserving cached devices`,
            );
          }
        }
        this.lastDetectionTime = detectedAt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[Devices] Watch refresh failed: ${message}`);
      } finally {
        this.detectionInProgress = false;
      }
    }, this.watchDebounceMs);
  }

  /**
   * Get cached devices without triggering detection.
   *
   * @returns Cached devices (may be stale).
   */
  getCachedDevices(moduleNames?: readonly string[]): DeviceDescriptorT[] {
    return this.collectCachedDevices(
      moduleNames ?? this.deps.moduleRegistry.getModuleNames(),
    );
  }

  /**
   * Clear cache and stop watchers.
   */
  clear(): void {
    this.cachedDevicesByModule.clear();
    this.lastDetectionTimeByModule.clear();
    this.lastDetectionTime = 0;
    if (this.watchRefreshTimer) {
      this.deps.clearTimeoutFn(this.watchRefreshTimer);
      this.watchRefreshTimer = undefined;
    }
    if (this.watchUnsubscribe) {
      this.watchUnsubscribe();
      this.watchUnsubscribe = undefined;
    }
    this.watchInitialized = false;
    this.pendingWatchModules.clear();
  }

  /**
   * Check if cache is fresh.
   *
   * @returns True when cache is recent and non-empty.
   */
  isFresh(): boolean {
    const now = this.deps.now();
    const moduleNames = this.deps.moduleRegistry.getModuleNames();
    return (
      this.collectCachedDevices(moduleNames).length > 0 &&
      moduleNames.every(
        (name) =>
          now - (this.lastDetectionTimeByModule.get(name) ?? 0) <
          this.cacheTtlMs,
      )
    );
  }

  private collectCachedDevices(moduleNames: readonly string[]): DeviceDescriptorT[] {
    return moduleNames.flatMap(
      (name) => this.cachedDevicesByModule.get(name) ?? [],
    );
  }
}

/**
 * Singleton instance
 */
export const deviceCache = new DeviceCache();
