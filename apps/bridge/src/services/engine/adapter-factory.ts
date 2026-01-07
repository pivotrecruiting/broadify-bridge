import type { EngineAdapter, EngineConnectConfig } from "./engine-adapter-interface.js";
import { AtemAdapter } from "./adapters/atem-adapter.js";
import { VmixAdapter } from "./adapters/vmix-adapter.js";
import { TricasterAdapter } from "./adapters/tricaster-adapter.js";

/**
 * Create an engine adapter instance based on type
 *
 * Factory function for creating engine adapters.
 * Currently supports ATEM, vMix, and Tricaster adapters.
 *
 * @param type Engine type
 * @returns Engine adapter instance
 * @throws Error if engine type is not supported
 */
export function createEngineAdapter(type: EngineConnectConfig["type"]): EngineAdapter {
  switch (type) {
    case "atem":
      return new AtemAdapter();
    case "vmix":
      return new VmixAdapter();
    case "tricaster":
      return new TricasterAdapter();
    default:
      throw new Error(`Unsupported engine type: ${type}`);
  }
}

