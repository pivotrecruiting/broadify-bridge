import type { DeviceModule, DeviceController } from "./device-module.js";
import type { DeviceDescriptorT } from "../../../../types.js";

const DEFAULT_DETECTION_TIMEOUT = 5000; // 5 seconds per module

/**
 * Module registry for device detection
 *
 * Manages multiple device modules and coordinates parallel detection
 * with error isolation and timeout protection.
 */
export class ModuleRegistry {
  private modules: DeviceModule[] = [];

  /**
   * Register a device module
   */
  register(module: DeviceModule): void {
    this.modules.push(module);
  }

  /**
   * Detect devices from all registered modules in parallel
   *
   * Features:
   * - Parallel detection (all modules simultaneously)
   * - Timeout protection per module
   * - Error isolation (one broken module doesn't kill everything)
   * - Results merged into single array
   *
   * Phase 1: Async Detection + Timeout + Cache (current implementation)
   * Phase 2: Worker Thread isolation for native SDK calls (can be added later)
   *
   * @param timeoutMs Timeout per module in milliseconds
   * @param useWorkerThreads Whether to use worker threads for isolation (Phase 2)
   * @returns Array of all detected devices
   */
  async detectAll(
    timeoutMs: number = DEFAULT_DETECTION_TIMEOUT,
    useWorkerThreads: boolean = false
  ): Promise<DeviceDescriptorT[]> {
    // Phase 1: Direct async detection with timeout
    // Phase 2: Worker thread isolation can be added here for SDK-heavy modules

    if (useWorkerThreads) {
      // TODO: Implement worker thread isolation for Phase 2
      // This would be useful for BMD SDK calls that might block
      return this.detectAllWithWorkers(timeoutMs);
    }

    // Current implementation: Direct async with timeout
    const detectionPromises = this.modules.map(async (module) => {
      try {
        // Wrap detection in timeout
        const timeoutPromise = new Promise<DeviceDescriptorT[]>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `Timeout: ${module.name} detection exceeded ${timeoutMs}ms`
                )
              ),
            timeoutMs
          );
        });

        const detectionPromise = module.detect();

        const devices = await Promise.race([detectionPromise, timeoutPromise]);
        return devices;
      } catch (error) {
        // Error isolation: log but don't fail entire detection
        console.error(
          `[ModuleRegistry] Error detecting devices in module ${module.name}:`,
          error
        );
        return [];
      }
    });

    // Wait for all modules (failed ones return empty arrays)
    const results = await Promise.all(detectionPromises);

    // Merge all results
    const allDevices: DeviceDescriptorT[] = [];
    for (const devices of results) {
      allDevices.push(...devices);
    }

    return allDevices;
  }

  /**
   * Detect devices using worker threads (Phase 2)
   *
   * TODO: Implement worker thread isolation for native SDK calls
   * This prevents SDK blocking from affecting Fastify request threads
   */
  private async detectAllWithWorkers(
    timeoutMs: number
  ): Promise<DeviceDescriptorT[]> {
    // Phase 2 implementation placeholder
    // Worker threads would be created here for SDK-heavy modules
    // For now, fall back to direct detection
    return this.detectAll(timeoutMs, false);
  }

  /**
   * Get device controller for a specific device
   *
   * Finds the module that owns the device and creates a controller.
   *
   * @param deviceId Stable device ID
   * @returns Device controller
   * @throws Error if device not found or controller cannot be created
   */
  async getController(deviceId: string): Promise<DeviceController> {
    // First, detect all devices to find which module owns this device
    const allDevices = await this.detectAll();

    const device = allDevices.find((d) => d.id === deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Find module that detected this device
    // We need to check each module to see which one owns it
    for (const module of this.modules) {
      try {
        const devices = await module.detect();
        if (devices.some((d) => d.id === deviceId)) {
          return module.createController(deviceId);
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        // Continue to next module
        continue;
      }
    }

    throw new Error(`No module found for device ${deviceId}`);
  }

  /**
   * Get all registered module names
   */
  getModuleNames(): string[] {
    return this.modules.map((m) => m.name);
  }

  /**
   * Get number of registered modules
   */
  getModuleCount(): number {
    return this.modules.length;
  }
}

/**
 * Singleton instance
 */
export const moduleRegistry = new ModuleRegistry();
