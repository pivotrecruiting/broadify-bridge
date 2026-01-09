import { moduleRegistry } from "./module-registry.js";
import { USBCaptureModule } from "./usb-capture/index.js";

/**
 * Initialize and register all device modules
 * 
 * This function should be called during bridge startup to register
 * all available device modules.
 */
export function initializeModules(): void {
  // Register USB Capture module
  moduleRegistry.register(new USBCaptureModule());

  // Additional modules can be registered here in the future
}

/**
 * Get module registry instance
 */
export { moduleRegistry };

