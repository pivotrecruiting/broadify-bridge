/**
 * Load electron-updater via createRequire so it can be mocked in tests
 * without triggering import.meta/require in the main service.
 */
import { createRequire } from "node:module";

const requireFromModule = createRequire(import.meta.url);
const { autoUpdater } = requireFromModule("electron-updater") as typeof import("electron-updater");

export { autoUpdater };
