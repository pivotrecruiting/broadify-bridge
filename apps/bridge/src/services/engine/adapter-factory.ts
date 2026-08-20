import type {
  EngineAdapter,
  EngineConnectConfig,
  EngineTransportT,
} from "./engine-adapter-interface.js";
import { AtemAdapter } from "./adapters/atem-adapter.js";
import { AtemUsbAdapter } from "./adapters/atem-usb-adapter.js";
import { VmixAdapter } from "./adapters/vmix-adapter.js";
import { TricasterAdapter } from "./adapters/tricaster-adapter.js";

/**
 * Create an engine adapter instance based on type and transport
 *
 * Factory function for creating engine adapters.
 * Currently supports ATEM (network + USB), vMix, and Tricaster adapters.
 *
 * @param type Engine type
 * @param transport Engine transport (default "network"; "usb" is ATEM-only)
 * @returns Engine adapter instance
 * @throws Error if the engine type/transport combination is not supported
 */
export function createEngineAdapter(
  type: EngineConnectConfig["type"],
  transport: EngineTransportT = "network"
): EngineAdapter {
  if (transport === "usb" && type !== "atem") {
    throw new Error(`Unsupported engine transport "usb" for type: ${type}`);
  }
  switch (type) {
    case "atem":
      return transport === "usb" ? new AtemUsbAdapter() : new AtemAdapter();
    case "vmix":
      return new VmixAdapter();
    case "tricaster":
      return new TricasterAdapter();
    default:
      throw new Error(`Unsupported engine type: ${type}`);
  }
}
