import type { BridgeOutputsDiagnosticsT, DeviceDescriptorT } from "@broadify/protocol";
import type { DecklinkDiagnosticsT } from "../modules/decklink/decklink-helper.js";
import type { DisplayDiagnosticsT } from "../modules/display/display-diagnostics.js";

type BuildDisplayDiagnosticsOptionsT = {
  displayRegistered: boolean;
  displayDiagnostics?: DisplayDiagnosticsT | null;
  displayDeviceCount: number;
};

type BuildOutputsDiagnosticsOptionsT = {
  platform?: NodeJS.Platform;
  decklinkRegistered: boolean;
  decklinkDiagnostics?: DecklinkDiagnosticsT | null;
  decklinkDeviceCount: number;
} & Partial<BuildDisplayDiagnosticsOptionsT>;

type DisplayOutputsDiagnosticsT = NonNullable<BridgeOutputsDiagnosticsT["display"]>;

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

export function getDisplayDeviceCount(devices: DeviceDescriptorT[]): number {
  return devices.filter((device) => device.type === "display").length;
}

const buildDecklinkDiagnostics = (
  options: BuildOutputsDiagnosticsOptionsT,
): BridgeOutputsDiagnosticsT["decklink"] => {
  const diagnostics = options.decklinkDiagnostics;

  if (!options.decklinkRegistered) {
    return { state: "unsupported_platform" };
  }

  if (diagnostics?.helperMissing) {
    return {
      state: "helper_missing",
      ...details(diagnostics),
    };
  }

  if (diagnostics?.apiAvailable === false) {
    return {
      state: "api_unavailable",
      ...details(diagnostics),
    };
  }

  if (options.decklinkDeviceCount === 0) {
    return {
      state: "no_devices",
      ...details(diagnostics),
    };
  }

  return {
    state: "ok",
    ...details(diagnostics),
  };
};

/**
 * Build the `display` part of the outputs diagnostics.
 *
 * Returns `undefined` when no display module is registered so the field stays
 * absent. Without module diagnostics (no detection has run yet) the state is
 * derived from the number of display devices currently known.
 */
export function buildDisplayDiagnostics(
  options: BuildDisplayDiagnosticsOptionsT,
): DisplayOutputsDiagnosticsT | undefined {
  if (!options.displayRegistered) {
    return undefined;
  }

  const diagnostics = options.displayDiagnostics;
  if (!diagnostics) {
    return { state: options.displayDeviceCount > 0 ? "ok" : "no_devices" };
  }

  return {
    state: diagnostics.state,
    ...(diagnostics.message ? { message: diagnostics.message } : {}),
    ...(diagnostics.exitCode !== undefined
      ? { exitCode: diagnostics.exitCode }
      : {}),
  };
}

export function buildOutputsDiagnostics(
  options: BuildOutputsDiagnosticsOptionsT,
): BridgeOutputsDiagnosticsT {
  const platform = options.platform ?? process.platform;
  const display = buildDisplayDiagnostics({
    displayRegistered: options.displayRegistered ?? false,
    displayDiagnostics: options.displayDiagnostics,
    displayDeviceCount: options.displayDeviceCount ?? 0,
  });

  return {
    platform,
    decklink: buildDecklinkDiagnostics(options),
    ...(display ? { display } : {}),
  };
}
