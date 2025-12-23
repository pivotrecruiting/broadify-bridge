import type { DeviceDescriptorT } from "../../../../types.js";
import { moduleRegistry } from "../modules/module-registry.js";

/**
 * Device cache service
 *
 * Manages caching of device detection results with refresh logic
 */
export class DeviceCache {
  private cachedDevices: DeviceDescriptorT[] = [];
  private lastDetectionTime = 0;
  private detectionInProgress = false;

  /**
   * Cache TTL in milliseconds
   */
  private readonly CACHE_TTL = 1000; // 1 second

  /**
   * Rate limit for manual refreshes in milliseconds
   */
  private readonly REFRESH_RATE_LIMIT = 2000; // 2 seconds

  /**
   * Get cached devices or perform detection if cache expired
   */
  async getDevices(forceRefresh = false): Promise<DeviceDescriptorT[]> {
    const now = Date.now();
    const timeSinceLastDetection = now - this.lastDetectionTime;

    // Check if refresh is needed
    const needsRefresh =
      forceRefresh ||
      this.cachedDevices.length === 0 ||
      timeSinceLastDetection >= this.CACHE_TTL;

    if (!needsRefresh) {
      return this.cachedDevices;
    }

    // Check rate limit for manual refresh
    if (forceRefresh) {
      const timeSinceLastRefresh = now - this.lastDetectionTime;
      if (timeSinceLastRefresh < this.REFRESH_RATE_LIMIT) {
        throw new Error(
          `Rate limit exceeded. Please wait ${Math.ceil(
            (this.REFRESH_RATE_LIMIT - timeSinceLastRefresh) / 1000
          )} seconds`
        );
      }
    }

    // Prevent concurrent detection
    if (this.detectionInProgress) {
      // Wait for ongoing detection
      while (this.detectionInProgress) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return this.cachedDevices;
    }

    // Perform detection
    this.detectionInProgress = true;
    try {
      this.cachedDevices = await moduleRegistry.detectAll();
      this.lastDetectionTime = Date.now();
      return this.cachedDevices;
    } finally {
      this.detectionInProgress = false;
    }
  }

  /**
   * Get cached devices without triggering detection
   */
  getCachedDevices(): DeviceDescriptorT[] {
    return this.cachedDevices;
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cachedDevices = [];
    this.lastDetectionTime = 0;
  }

  /**
   * Check if cache is fresh
   */
  isFresh(): boolean {
    const now = Date.now();
    const timeSinceLastDetection = now - this.lastDetectionTime;
    return (
      this.cachedDevices.length > 0 && timeSinceLastDetection < this.CACHE_TTL
    );
  }
}

/**
 * Singleton instance
 */
export const deviceCache = new DeviceCache();
