import type { BridgeOutputsT, DeviceDescriptorT } from "@broadify/protocol";
import type { DeviceModule } from "../modules/device-module.js";
import { moduleRegistry } from "../modules/index.js";
import { graphicsManager } from "./graphics/graphics-manager.js";
import { transformDevicesToOutputs } from "./device-to-output-transform.js";
import {
  buildOutputsDiagnostics,
  getDecklinkDeviceCount,
  getDisplayDeviceCount,
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
  const displayModule = deps.moduleRegistry.getModule("display");
  const decklinkDiagnostics = decklinkModule?.getLastDiagnostics?.() ?? null;
  const displayDiagnostics = displayModule?.getLastDiagnostics?.() ?? null;

  outputs.diagnostics = buildOutputsDiagnostics({
    platform: deps.platform,
    decklinkRegistered: !!decklinkModule,
    decklinkDiagnostics:
      decklinkDiagnostics?.kind === "decklink" ? decklinkDiagnostics : null,
    decklinkDeviceCount: getDecklinkDeviceCount(devices),
    displayRegistered: !!displayModule,
    displayDiagnostics:
      displayDiagnostics?.kind === "display" ? displayDiagnostics : null,
    displayDeviceCount: getDisplayDeviceCount(devices),
  });

  return outputs;
}
