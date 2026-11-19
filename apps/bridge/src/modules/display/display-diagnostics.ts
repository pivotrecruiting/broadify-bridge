import type { BridgeOutputsDiagnosticsDisplayStateT } from "@broadify/protocol";
import {
  WindowsDisplayHelperError,
  type WindowsDisplayHelperErrorKindT,
} from "./windows-display-helper.js";

/**
 * Last known health of the display detection path, captured by the display
 * module during `detect()` and surfaced via `outputs.diagnostics.display`.
 */
export type DisplayDiagnosticsT = {
  state: BridgeOutputsDiagnosticsDisplayStateT;
  message?: string;
  exitCode?: number;
};

const HELPER_ERROR_KIND_TO_STATE: Readonly<
  Record<WindowsDisplayHelperErrorKindT, BridgeOutputsDiagnosticsDisplayStateT>
> = {
  spawn_failed: "helper_failed",
  helper_missing: "helper_missing",
  missing_runtime: "missing_runtime",
  helper_failed: "helper_failed",
  timeout: "helper_failed",
  invalid_response: "helper_failed",
  response_too_large: "helper_failed",
};

/**
 * Map a detection error to display diagnostics.
 *
 * Windows helper errors carry a kind that distinguishes a missing runtime or
 * binary from other failures; every other error (e.g. macOS system_profiler)
 * is reported as `helper_failed` with its message.
 */
export const displayDiagnosticsFromError = (error: unknown): DisplayDiagnosticsT => {
  if (error instanceof WindowsDisplayHelperError) {
    return {
      state: HELPER_ERROR_KIND_TO_STATE[error.kind],
      message: error.message,
      ...(error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
    };
  }
  return {
    state: "helper_failed",
    message: error instanceof Error ? error.message : String(error),
  };
};
