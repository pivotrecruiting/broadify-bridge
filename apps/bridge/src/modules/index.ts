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
  const currentPlatform = platform();

  // Register USB Capture module
  moduleRegistry.register(new USBCaptureModule());

  if (currentPlatform === "darwin") {
    // macOS-only module (DeckLink SDK).
    moduleRegistry.register(new DecklinkModule());
  }

  if (currentPlatform === "darwin" || currentPlatform === "win32") {
    // External display output module (native helper + FrameBus path).
    moduleRegistry.register(new DisplayModule());
  }

  // Additional modules can be registered here in the future
}

/**
 * Get module registry instance.
 */
export { moduleRegistry };
