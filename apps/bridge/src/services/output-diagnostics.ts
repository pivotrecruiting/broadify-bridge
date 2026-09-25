import type { BridgeOutputsDiagnosticsT, DeviceDescriptorT } from "@broadify/protocol";
import type { DecklinkDiagnosticsT } from "../modules/decklink/decklink-helper.js";

type BuildOutputsDiagnosticsOptionsT = {
  platform?: NodeJS.Platform;
  decklinkRegistered: boolean;
  decklinkDiagnostics?: DecklinkDiagnosticsT | null;
  decklinkDeviceCount: number;
};

const getMessage = (
  diagnostics: DecklinkDiagnosticsT | null | undefined,
): string | undefined => diagnostics?.message ?? diagnostics?.error;

const details = (
  diagnostics: DecklinkDiagnosticsT | null | undefined,
): Pick<
  BridgeOutputsDiagnosticsT["decklink"],
  "apiVersion" | "helperVersion" | "message"
> => ({
  ...(diagnostics?.apiVersion ? { apiVersion: diagnostics.apiVersion } : {}),
  ...(diagnostics?.helperVersion
    ? { helperVersion: diagnostics.helperVersion }
    : {}),
  ...(getMessage(diagnostics) ? { message: getMessage(diagnostics) } : {}),
});

export function getDecklinkDeviceCount(devices: DeviceDescriptorT[]): number {
  return devices.filter((device) => device.type === "decklink").length;
}

export function buildOutputsDiagnostics(
  options: BuildOutputsDiagnosticsOptionsT,
): BridgeOutputsDiagnosticsT {
  const platform = options.platform ?? process.platform;
  const diagnostics = options.decklinkDiagnostics;

  if (!options.decklinkRegistered) {
    return {
      platform,
      decklink: { state: "unsupported_platform" },
    };
  }

  if (diagnostics?.helperMissing) {
    return {
      platform,
      decklink: {
        state: "helper_missing",
        ...details(diagnostics),
      },
    };
  }

  if (diagnostics?.apiAvailable === false) {
    return {
      platform,
      decklink: {
        state: "api_unavailable",
        ...details(diagnostics),
      },
    };
  }

  if (options.decklinkDeviceCount === 0) {
    return {
      platform,
      decklink: {
        state: "no_devices",
        ...details(diagnostics),
      },
    };
  }

  return {
    platform,
    decklink: {
      state: "ok",
      ...details(diagnostics),
    },
  };
}
