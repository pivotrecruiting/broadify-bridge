import type { EngineAdapter, EngineConnectConfig } from "./engine-adapter-interface.js";
import { AtemAdapter } from "./adapters/atem-adapter.js";

/**
 * Create an engine adapter instance based on type
 *
 * Factory function for creating engine adapters.
 * Currently supports ATEM, Tricaster and vMix adapters can be added later.
 *
 * @param type Engine type
 * @returns Engine adapter instance
 * @throws Error if engine type is not supported
 */
export function createEngineAdapter(type: EngineConnectConfig["type"]): EngineAdapter {
  switch (type) {
    case "atem":
      return new AtemAdapter();
    case "tricaster":
      // TODO: Implement TricasterAdapter
      throw new Error("Tricaster adapter not yet implemented");
    case "vmix":
      // TODO: Implement vMixAdapter
      throw new Error("vMix adapter not yet implemented");
    default:
      throw new Error(`Unsupported engine type: ${type}`);
  }
}

