/**
 * Engine error codes
 */
export enum EngineErrorCode {
  // Connection errors
  CONNECTION_TIMEOUT = "CONNECTION_TIMEOUT",
  CONNECTION_REFUSED = "CONNECTION_REFUSED",
  NETWORK_ERROR = "NETWORK_ERROR",
  INVALID_IP = "INVALID_IP",
  INVALID_PORT = "INVALID_PORT",
  DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND",
  DEVICE_UNREACHABLE = "DEVICE_UNREACHABLE",

  // State errors
  ALREADY_CONNECTED = "ALREADY_CONNECTED",
  ALREADY_CONNECTING = "ALREADY_CONNECTING",
  NOT_CONNECTED = "NOT_CONNECTED",

  // Protocol errors
  PROTOCOL_ERROR = "PROTOCOL_ERROR",
  AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED",

  // Unknown errors
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Engine error class with structured error information
 */
export class EngineError extends Error {
  public readonly code: EngineErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to JSON-serializable object
   */
  toJSON(): {
    code: EngineErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

/**
 * Create connection timeout error
 */
export function createConnectionTimeoutError(
  ip: string,
  port: number,
  timeoutMs: number
): EngineError {
  return new EngineError(
    EngineErrorCode.CONNECTION_TIMEOUT,
    `Connection timeout: Device at ${ip}:${port} did not respond within ${timeoutMs}ms. Check if the device is powered on and reachable.`,
    { ip, port, timeoutMs }
  );
}

/**
 * Create connection refused error
 */
export function createConnectionRefusedError(
  ip: string,
  port: number
): EngineError {
  return new EngineError(
    EngineErrorCode.CONNECTION_REFUSED,
    `Connection refused: Device at ${ip}:${port} refused the connection. Check if the device is running and the port is correct.`,
    { ip, port }
  );
}

/**
 * Create network error
 */
export function createNetworkError(
  ip: string,
  port: number,
  originalError?: Error
): EngineError {
  return new EngineError(
    EngineErrorCode.NETWORK_ERROR,
    `Network error: Cannot reach device at ${ip}:${port}. Check network connectivity and IP address.`,
    { ip, port, originalError: originalError?.message }
  );
}

/**
 * Create device unreachable error
 */
export function createDeviceUnreachableError(
  ip: string,
  port: number
): EngineError {
  return new EngineError(
    EngineErrorCode.DEVICE_UNREACHABLE,
    `Device unreachable: Cannot reach device at ${ip}:${port}. Check if the device is powered on and connected to the network.`,
    { ip, port }
  );
}

/**
 * Create already connected error
 */
export function createAlreadyConnectedError(): EngineError {
  return new EngineError(
    EngineErrorCode.ALREADY_CONNECTED,
    "Engine is already connected. Disconnect first before connecting again."
  );
}

/**
 * Create already connecting error
 */
export function createAlreadyConnectingError(): EngineError {
  return new EngineError(
    EngineErrorCode.ALREADY_CONNECTING,
    "Engine connection is already in progress. Please wait for the current connection attempt to complete."
  );
}

/**
 * Create not connected error
 */
export function createNotConnectedError(operation: string): EngineError {
  return new EngineError(
    EngineErrorCode.NOT_CONNECTED,
    `Cannot ${operation}: Engine is not connected. Connect to an engine first.`,
    { operation }
  );
}


/**
 * Create error for USB transport when the Blackmagic ATEM software (which
 * ships the SDK runtime the USB helper loads) is not installed.
 */
export function createAtemSoftwareMissingError(): EngineError {
  return new EngineError(
    EngineErrorCode.DEVICE_NOT_FOUND,
    "Blackmagic ATEM software is not installed. Install the ATEM software (which provides the USB driver runtime) and try again, or connect via network instead.",
    { transport: "usb", reason: "atem_software_not_installed" }
  );
}

/**
 * Create error for USB transport when no switcher is attached via USB.
 */
export function createUsbSwitcherNotFoundError(): EngineError {
  return new EngineError(
    EngineErrorCode.DEVICE_NOT_FOUND,
    "No ATEM switcher found on USB. Check the USB cable and that the switcher is powered on.",
    { transport: "usb", reason: "no_usb_switcher_found" }
  );
}

/**
 * Create error for USB transport connect failures reported by the helper
 * (e.g. incompatible firmware between switcher and installed ATEM software).
 */
export function createUsbConnectFailedError(reason: string): EngineError {
  const code =
    reason === "incompatible_firmware"
      ? EngineErrorCode.PROTOCOL_ERROR
      : EngineErrorCode.NETWORK_ERROR;
  const message =
    reason === "incompatible_firmware"
      ? "The switcher firmware and the installed ATEM software are incompatible. Update the Blackmagic ATEM software and switcher firmware to matching versions."
      : `USB connection to the ATEM switcher failed (${reason}). Reconnect the USB cable and try again.`;
  return new EngineError(code, message, { transport: "usb", reason });
}
