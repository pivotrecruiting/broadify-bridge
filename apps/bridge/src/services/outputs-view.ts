import type { BridgeOutputsT, DeviceDescriptorT } from "@broadify/protocol";
import type { DeviceModule } from "../modules/device-module.js";
import { moduleRegistry } from "../modules/index.js";
import { graphicsManager } from "./graphics/graphics-manager.js";
import { transformDevicesToOutputs } from "./device-to-output-transform.js";
import {
  buildOutputsDiagnostics,
  getDecklinkDeviceCount,
} from "./output-diagnostics.js";

type OutputsViewGraphicsStatusT = {
  outputConfig?: {
    targets?: {
      output1Id?: string;
      output2Id?: string;
    };
  } | null;
};

type OutputsViewDepsT = {
  graphicsManager: {
    getStatus(): OutputsViewGraphicsStatusT;
  };
  moduleRegistry: {
    getModule(moduleName: string): DeviceModule | undefined;
  };
  platform: NodeJS.Platform;
};

const defaultDeps: OutputsViewDepsT = {
  graphicsManager,
  moduleRegistry,
  platform: process.platform,
};

const getOwnedPortIds = (
  status: OutputsViewGraphicsStatusT,
): ReadonlySet<string> =>
  new Set(
    [
      status.outputConfig?.targets?.output1Id,
      status.outputConfig?.targets?.output2Id,
    ].filter((portId): portId is string => typeof portId === "string"),
  );

export function buildBridgeOutputsView(
  devices: DeviceDescriptorT[],
  deps: OutputsViewDepsT = defaultDeps,
): BridgeOutputsT {
  const ownedPortIds = getOwnedPortIds(deps.graphicsManager.getStatus());
  const outputs = transformDevicesToOutputs(devices, { ownedPortIds });
  const decklinkModule = deps.moduleRegistry.getModule("decklink");

  outputs.diagnostics = buildOutputsDiagnostics({
    platform: deps.platform,
    decklinkRegistered: !!decklinkModule,
    decklinkDiagnostics: decklinkModule?.getLastDiagnostics?.() ?? null,
    decklinkDeviceCount: getDecklinkDeviceCount(devices),
  });

  return outputs;
}
