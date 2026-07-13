import type {
  DeviceModule,
  DeviceController,
  UnsubscribeFunction,
} from "./device-module.js";
import type { DeviceDescriptorT } from "@broadify/protocol";

const DEFAULT_DETECTION_TIMEOUT = 5000; // 5 seconds per module

export type ModuleDetectionStatusT = "success" | "timeout" | "error";

export type ModuleDetectionResultT = {
  moduleName: string;
  status: ModuleDetectionStatusT;
  devices: DeviceDescriptorT[];
  durationMs: number;
  errorCode?: "detection_timeout" | "detection_failed";
};

/**
 * Module registry for device detection.
 *
 * Manages multiple device modules and coordinates parallel detection
 * with error isolation and timeout protection.
 */
export class ModuleRegistry {
  private modules: DeviceModule[] = [];

  /**
   * Register a device module.
   *
   * @param module Device module instance.
   */
  register(module: DeviceModule): void {
    this.modules.push(module);
  }

  /**
   * Detect devices from all registered modules in parallel.
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
   * @param timeoutMs Timeout per module in milliseconds.
   * @param useWorkerThreads Whether to use worker threads for isolation (Phase 2).
   * @returns Array of all detected devices.
   */
  async detectAll(
    timeoutMs?: number,
    useWorkerThreads: boolean = false
  ): Promise<DeviceDescriptorT[]> {
    // Phase 1: Direct async detection with timeout
    // Phase 2: Worker thread isolation can be added here for SDK-heavy modules

    if (useWorkerThreads) {
      // TODO: Implement worker thread isolation for Phase 2
      // This would be useful for native SDK calls that might block
      return this.detectAllWithWorkers(timeoutMs ?? DEFAULT_DETECTION_TIMEOUT);
    }

    const results = await this.detectModules(undefined, timeoutMs);
    return results.flatMap((result) => result.devices);
  }

  /**
   * Detect selected modules and preserve status information for cache policy.
   */
  async detectModules(
    moduleNames?: readonly string[],
    timeoutMs?: number,
  ): Promise<ModuleDetectionResultT[]> {
    const requestedNames = moduleNames ? new Set(moduleNames) : null;
    const modules = requestedNames
      ? this.modules.filter((module) => requestedNames.has(module.name))
      : this.modules;

    const detectionPromises = modules.map(async (module) => {
      const startedAt = Date.now();
      const moduleTimeoutMs =
        timeoutMs ?? module.detectionTimeoutMs ?? DEFAULT_DETECTION_TIMEOUT;
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<DeviceDescriptorT[]>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                `Timeout: ${module.name} detection exceeded ${moduleTimeoutMs}ms`
              )
            ),
          moduleTimeoutMs
        );
      });

      try {
        const detectionPromise = module.detect();
        const devices = await Promise.race([detectionPromise, timeoutPromise]);
        return {
          moduleName: module.name,
          status: "success" as const,
          devices,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const isTimeout =
          error instanceof Error && error.message.startsWith("Timeout:");
        console.error(
          `[ModuleRegistry] Error detecting devices in module ${module.name}:`,
          error
        );
        return {
          moduleName: module.name,
          status: isTimeout ? ("timeout" as const) : ("error" as const),
          devices: [],
          durationMs: Date.now() - startedAt,
          errorCode: isTimeout
            ? ("detection_timeout" as const)
            : ("detection_failed" as const),
        };
      } finally {
        clearTimeout(timeoutId!);
      }
    });

    return Promise.all(detectionPromises);
  }

  /**
   * Detect devices using worker threads (Phase 2).
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
   * Get device controller for a specific device.
   *
   * Finds the module that owns the device and creates a controller.
   *
   * @param deviceId Stable device ID
   * @returns Device controller
   * @throws Error if device not found or controller cannot be created
   */
  async getController(
    deviceId: string,
    moduleName?: string,
  ): Promise<DeviceController> {
    if (moduleName) {
      const owner = this.modules.find((module) => module.name === moduleName);
      if (!owner) {
        throw new Error(`Device module ${moduleName} not found`);
      }
      const [result] = await this.detectModules([moduleName]);
      if (
        result?.status !== "success" ||
        !result.devices.some((device) => device.id === deviceId)
      ) {
        throw new Error(`Device ${deviceId} not found`);
      }
      return owner.createController(deviceId);
    }

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
   * Watch for device changes across all modules that support it.
   *
   * @param callback Called on each module's change event.
   * @returns Unsubscribe function.
   */
  watchAll(
    callback: (moduleName: string, devices: DeviceDescriptorT[]) => void
  ): UnsubscribeFunction {
    const unsubscribes: UnsubscribeFunction[] = [];

    for (const module of this.modules) {
      if (!module.watch) {
        continue;
      }
      const unsubscribe = module.watch((devices) =>
        callback(module.name, devices)
      );
      unsubscribes.push(unsubscribe);
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch (error) {
          console.warn(
            `[ModuleRegistry] Failed to unsubscribe watcher: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };
  }

  /**
   * Get all registered module names.
   */
  getModuleNames(): string[] {
    return this.modules.map((m) => m.name);
  }

  /**
   * Get number of registered modules.
   */
  getModuleCount(): number {
    return this.modules.length;
  }
}

/**
 * Singleton instance
 */
export const moduleRegistry = new ModuleRegistry();
