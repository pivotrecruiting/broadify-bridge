import type { DeviceDescriptorT } from "@broadify/protocol";
import { moduleRegistry } from "../modules/module-registry.js";
import { getBridgeContext } from "./bridge-context.js";

type DeviceCacheLoggerT = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
};

type DeviceCacheDepsT = {
  moduleRegistry: Pick<typeof moduleRegistry, "getModuleNames" | "detectAll" | "watchAll">;
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
  private cachedDevices: DeviceDescriptorT[] = [];
  private lastDetectionTime = 0;
  private detectionInProgress = false;
  private watchInitialized = false;
  private watchUnsubscribe: (() => void) | undefined;
  private watchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
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
  async getDevices(forceRefresh = false): Promise<DeviceDescriptorT[]> {
    const logger = this.deps.getLogger();
    const logDebug = logger.debug?.bind(logger);
    const now = this.deps.now();
    const timeSinceLastDetection = now - this.lastDetectionTime;

    // Check if refresh is needed
    const needsRefresh =
      forceRefresh ||
      this.cachedDevices.length === 0 ||
      timeSinceLastDetection >= this.cacheTtlMs;

    if (!needsRefresh) {
      logDebug?.(
        `[Devices] Using cached results (${this.cachedDevices.length} devices)`
      );
      return this.cachedDevices;
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
      return this.cachedDevices;
    }

    // Perform detection
    this.detectionInProgress = true;
    try {
      const moduleNames = this.deps.moduleRegistry.getModuleNames().join(", ");
      logDebug?.(
        `[Devices] Detecting devices (forceRefresh=${forceRefresh}) [modules: ${moduleNames || "none"}]`
      );
      this.cachedDevices = await this.deps.moduleRegistry.detectAll();
      this.lastDetectionTime = this.deps.now();

      const typeCounts = this.cachedDevices.reduce<Record<string, number>>(
        (acc, device) => {
          acc[device.type] = (acc[device.type] || 0) + 1;
          return acc;
        },
        {}
      );
      const totalPorts = this.cachedDevices.reduce(
        (sum, device) => sum + device.ports.length,
        0
      );

      logDebug?.(
        `[Devices] Detection complete: ${this.cachedDevices.length} devices, ${totalPorts} ports (by type: ${JSON.stringify(
          typeCounts
        )})`
      );

      if (this.cachedDevices.length === 0) {
        logger.warn(
          "[Devices] No devices detected. Check device drivers and connections."
        );
      }

      return this.cachedDevices;
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
      this.scheduleWatchRefresh();
    });
  }

  /**
   * Schedule a debounced refresh when a watch event is received.
   */
  private scheduleWatchRefresh(): void {
    if (this.watchRefreshTimer) {
      return;
    }

    this.watchRefreshTimer = this.deps.setTimeoutFn(async () => {
      this.watchRefreshTimer = undefined;
      const logger = this.deps.getLogger();
      const logDebug = logger.debug?.bind(logger);
      if (this.detectionInProgress) {
        logDebug?.("[Devices] Detection in progress, skipping watch refresh");
        return;
      }

      this.detectionInProgress = true;
      try {
        logDebug?.("[Devices] Refreshing cache from watch event");
        this.cachedDevices = await this.deps.moduleRegistry.detectAll();
        this.lastDetectionTime = this.deps.now();
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
  getCachedDevices(): DeviceDescriptorT[] {
    return this.cachedDevices;
  }

  /**
   * Clear cache and stop watchers.
   */
  clear(): void {
    this.cachedDevices = [];
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
  }

  /**
   * Check if cache is fresh.
   *
   * @returns True when cache is recent and non-empty.
   */
  isFresh(): boolean {
    const now = this.deps.now();
    const timeSinceLastDetection = now - this.lastDetectionTime;
    return (
      this.cachedDevices.length > 0 && timeSinceLastDetection < this.cacheTtlMs
    );
  }
}

/**
 * Singleton instance
 */
export const deviceCache = new DeviceCache();
