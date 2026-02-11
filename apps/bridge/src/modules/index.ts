import { moduleRegistry } from "./module-registry.js";
import { USBCaptureModule } from "./usb-capture/index.js";
import { DecklinkModule } from "./decklink/index.js";
import { DisplayModule } from "./display/index.js";
import { platform } from "node:os";

/**
 * Initialize and register all device modules.
 *
 * This function should be called during bridge startup to register
 * all available device modules.
 */
export function initializeModules(): void {
  // Register USB Capture module
  moduleRegistry.register(new USBCaptureModule());

  if (platform() === "darwin") {
    // macOS-only modules (DeckLink SDK + external display outputs).
    moduleRegistry.register(new DecklinkModule());
    moduleRegistry.register(new DisplayModule());
  }

  // Additional modules can be registered here in the future
}

/**
 * Get module registry instance.
 */
export { moduleRegistry };
