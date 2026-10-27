/**
 * Shared protocol types for Bridge and Desktop integration.
 */
export type Statistics = {
  cpuUsage: number;
  ramUsage: number;
  storageData: number;
};

export type StaticData = {
  totalStorage: number;
  cpuModel: string;
  totalMemoryGB: number;
};

export type BridgeConfig = {
  host: string;
  port: number;
  outputs?: {
    output1: string;
    output2: string;
  };
  networkBindingId?: string;
  userDataDir?: string;
};

export type BridgeStatus = {
  running: boolean;
  reachable: boolean;
  version?: string;
  uptime?: number;
  mode?: string;
  port?: number;
  host?: string;
  state?: "idle" | "configured" | "active";
  outputsConfigured?: boolean;
  error?: string;
  relayConnected?: boolean;
  bridgeId?: string;
  bridgeName?: string;
  webAppUrl?: string;
  pairingCode?: string;
  pairingExpiresAt?: string;
  pairingExpired?: boolean;
  platform?: NodeJS.Platform;
  outputCapabilities?: {
    decklink: boolean;
  };
};

/**
 * Port status information
 */
export type PortStatusT = {
  available: boolean; // UI filter: present && ready && !inUse
  signal?: "none" | "detected" | "locked";
  format?: string; // Current signal format (e.g. "1080p50")
  error?: string;
};

/**
 * Port capabilities
 */
export type PortCapabilitiesT = {
  formats: string[]; // e.g. ["1080p50", "1080p60", "4K30"]
  maxResolution?: string;
  modes?: OutputDisplayModeT[];
};

/**
 * Device status information
 */
export type DeviceStatusT = {
  present: boolean; // Device is detected
  inUse: boolean; // Another process holds the device
  ready: boolean; // Can be opened/controlled
  signal?: "none" | "detected" | "locked";
  error?: string;
  lastSeen: number; // Timestamp
};

/**
 * Port descriptor with capabilities and status
 */
export type PortDescriptorT = {
  id: string; // Stable port ID (deviceId + portIndex)
  displayName: string; // e.g. "SDI-A", "HDMI-OUT"
  type: "sdi" | "hdmi" | "usb" | "displayport" | "thunderbolt";
  direction: "input" | "output" | "bidirectional";
  role?: "fill" | "key" | "video";
  capabilities: PortCapabilitiesT;
  status: PortStatusT;
};

/**
 * Device descriptor with ports and status
 */
export type DeviceDescriptorT = {
  id: string; // Stable ID (not name!)
  displayName: string;
  // "display" refers to external monitor outputs (platform support varies).
  type: "usb-capture" | "decklink" | "display" | "other";
  vendor?: string;
  model?: string;
  driver?: string;
  ports: PortDescriptorT[];
  status: DeviceStatusT;
};

/**
 * Output device information from bridge (UI-compatible format)
 * @deprecated Use DeviceDescriptorT for internal representation
 */
export type OutputDeviceT = {
  id: string;
  name: string;
  // "display" represents external monitor outputs (HDMI/DP/Thunderbolt).
  type: "decklink" | "display" | "capture" | "connection";
  available: boolean;
  ownedByBridge?: boolean;
  deviceId?: string;
  portType?: PortDescriptorT["type"];
  portRole?: PortDescriptorT["role"];
  formats?: string[];
  modes?: OutputDisplayModeT[];
};

export type BridgeOutputsDiagnosticsDecklinkStateT =
  | "ok"
  | "unsupported_platform"
  | "helper_missing"
  | "api_unavailable"
  | "no_devices";

/**
 * Health state of the external display (HDMI/DisplayPort) detection path.
 *
 * - `ok`: the display helper ran and reported at least one external display.
 * - `unsupported_platform`: the bridge platform has no display detection.
 * - `helper_missing`: the native display helper binary could not be found
 *   (spawn failed with ENOENT, e.g. a broken or incomplete installation).
 * - `missing_runtime`: the native display helper exited with a Windows loader
 *   failure before reaching `main()`, e.g. STATUS_DLL_NOT_FOUND (0xC0000135)
 *   because the Microsoft Visual C++ runtime DLLs are not installed. Installing
 *   vc_redist.x64 or reinstalling the bridge resolves it.
 * - `helper_failed`: the helper spawned but detection still failed for another
 *   reason (non-zero exit, timeout, invalid or oversized response, spawn error
 *   other than ENOENT, or a macOS `system_profiler` failure).
 * - `no_devices`: detection succeeded but found no external display.
 */
export type BridgeOutputsDiagnosticsDisplayStateT =
  | "ok"
  | "unsupported_platform"
  | "helper_missing"
  | "missing_runtime"
  | "helper_failed"
  | "no_devices";

export type BridgeOutputsDiagnosticsT = {
  platform: NodeJS.Platform;
  decklink: {
    state: BridgeOutputsDiagnosticsDecklinkStateT;
    apiVersion?: string;
    helperVersion?: string;
    message?: string;
  };
  /**
   * External display detection health. Absent when the bridge has no display
   * module registered (older bridges omit the field entirely).
   */
  display?: {
    state: BridgeOutputsDiagnosticsDisplayStateT;
    /** Human-readable reason for the non-ok state, safe to show in the UI. */
    message?: string;
    /** Unsigned helper exit code (Windows DWORD, e.g. 3221225781 = 0xC0000135). */
    exitCode?: number;
  };
};

export type OutputDisplayModeT = {
  id: number;
  label: string;
  width: number;
  height: number;
  fps: number;
  fieldDominance: string;
  pixelFormats: string[];
};

/**
 * Outputs response from bridge (UI-compatible format)
 * This is a view on the Device/Port model
 */
export type BridgeOutputsT = {
  output1: OutputDeviceT[];
  output2: OutputDeviceT[];
  diagnostics?: BridgeOutputsDiagnosticsT;
};

export type LogFetchOptionsT = {
  lines?: number;
  filter?: string;
};

export type BridgeLogResponseT = {
  scope: "bridge";
  lines: number;
  content: string;
  error?: string;
};

export type BridgeLogClearResponseT = {
  scope: "bridge";
  cleared: boolean;
  error?: string;
};

export type AppLogResponseT = {
  scope: "app";
  lines: number;
  content: string;
  error?: string;
};

export type AppLogClearResponseT = {
  scope: "app";
  cleared: boolean;
  error?: string;
};

export type UnsubscribeFunction = () => void;

/**
 * Desktop app updater state.
 */
export type AppUpdaterStateT =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error";

/**
 * Desktop app updater status payload.
 */
export type AppUpdaterStatusT = {
  enabled: boolean;
  state: AppUpdaterStateT;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  channel: string;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  lastCheckedAt: string | null;
  errorCode: string | null;
  message: string | null;
};

/**
 * Generic updater command result payload.
 */
export type AppUpdaterActionResultT = {
  success: boolean;
  status: AppUpdaterStatusT;
  error?: string;
};

export type PortAvailability = {
  port: number;
  available: boolean;
};

/**
 * Port configuration for a specific network binding
 */
export type InterfacePortConfigT = {
  customOnly: boolean;
  defaultPort?: number;
};

/**
 * Network binding option with resolved IP address
 */
export type NetworkBindingOptionT = {
  id: string;
  label: string;
  bindAddress: string;
  interface: string;
  recommended: boolean;
  advanced: boolean;
  warning?: string;
  portConfig?: InterfacePortConfigT;
};

/**
 * Port configuration
 */
export type PortConfigT = {
  default: number;
  autoFallback: number[];
  allowCustom: boolean;
  customAdvancedOnly: boolean;
};

/**
 * Network binding configuration
 */
export type NetworkBindingConfigT = {
  default: {
    id: string;
    label: string;
    bindAddress: string;
    recommended: boolean;
    advanced: boolean;
    description: string;
  };
  options: Array<{
    id: string;
    label: string;
    bindAddress: string;
    interface: string;
    recommended: boolean;
    advanced: boolean;
    warning?: string;
    portConfig?: InterfacePortConfigT;
  }>;
  filters: {
    excludeInterfaces: string[];
    excludeIpRanges: string[];
    ipv6: boolean;
  };
};

/**
 * Complete network configuration
 */
export type NetworkConfigT = {
  networkBinding: NetworkBindingConfigT;
  port: PortConfigT;
  security: {
    lanMode: {
      enabled: boolean;
      requireAuth: boolean;
      readOnlyWithoutAuth: boolean;
    };
  };
};

/**
 * Engine connection status
 */
export type EngineStatusT =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/**
 * Macro execution status
 */
export type MacroStatusT =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "recording";

/**
 * Macro definition
 */
export type MacroT = {
  id: number;
  name: string;
  status: MacroStatusT;
};

export type MacroExecutionStatusT =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "stopped"
  | "failed";

export type MacroExecutionT = {
  runId: string;
  macroId: number;
  macroName?: string;
  engineType: "atem" | "tricaster" | "vmix" | "rodecaster";
  status: MacroExecutionStatusT;
  triggeredAt: number;
  acceptedAt?: number | null;
  startedAt: number | null;
  waitingAt: number | null;
  completedAt: number | null;
  actualDurationMs: number | null;
  loop: boolean;
  stopRequestedAt?: number | null;
  error?: string;
};

/**
 * Engine state information
 */
export type EngineStateT = {
  status: EngineStatusT;
  type?: "atem" | "tricaster" | "vmix" | "rodecaster";
  transport?: "network" | "usb";
  ip?: string;
  port?: number;
  macros: MacroT[];
  macroExecution?: MacroExecutionT | null;
  lastCompletedMacroExecution?: MacroExecutionT | null;
  lastUpdate?: number;
  error?: string;
};

/**
 * Live program (PGM) preview: the bridge captures the switcher's program
 * output (UVC or DeckLink input) and streams it to the web app over WebRTC.
 * Wire keys are snake_case (bridge <-> web app contract).
 */
export type VideoPixelFormatT =
  | "nv12"
  | "uyvy"
  | "yuy2"
  | "bgra"
  | "mjpeg"
  | "unknown";

export type VideoScanT =
  | "progressive"
  | "interlaced_tff"
  | "interlaced_bff"
  | "psf";

/** The signal currently present on a video input, as measured from real frames. */
export type VideoSignalT = {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  scan: VideoScanT;
  pixel_format: VideoPixelFormatT;
  no_signal: boolean;
};

export type VideoInputKindT = "uvc" | "decklink";

/** One selectable program source: a UVC device or a DeckLink input port. */
export type VideoInputDescriptorT = {
  id: string;
  kind: VideoInputKindT;
  display_name: string;
  device_id: string;
  port_id?: string;
  /** Survives re-enumeration and reboots (vendor/product/serial or port path). */
  stable_key: string;
  available: boolean;
  in_use: boolean;
  signal?: VideoSignalT;
};

export type PgmEncoderBackendT = "videotoolbox" | "mediafoundation";

export type PgmEncoderStatusT = {
  backend: PgmEncoderBackendT;
  hardware: boolean;
  bitrate_kbps: number;
  profile: string;
};

export type PgmLifecycleStateT =
  | "idle"
  | "starting"
  | "running"
  | "no_signal"
  | "error";

export type PgmErrorT = {
  code: string;
  message: string;
};

/** Snapshot published as `bridge_event pgm_status` and returned by `pgm_get_status`. */
export type PgmRecordingT = {
  active: boolean;
  file_path: string | null;
  started_at_ms: number | null;
  bytes: number;
  error: string | null;
};

export type PgmStatusT = {
  enabled: boolean;
  state: PgmLifecycleStateT;
  input: VideoInputDescriptorT | null;
  signal: VideoSignalT | null;
  encoder: PgmEncoderStatusT | null;
  audio: boolean;
  viewers: number;
  last_error: PgmErrorT | null;
  /** MP4 recording on the bridge machine (absent on older helpers). */
  recording?: PgmRecordingT | null;
};

/** Advertised in `get_status.capabilities.live_program`; the web app gates the tile on it. */
export type LiveProgramCapabilitiesT = {
  /** This bridge version/platform can stream the program (false: update the bridge). */
  supported: boolean;
  /** Machine kill switch (BRIDGE_PGM_PREVIEW=0); absent on older bridges means enabled. */
  enabled?: boolean;
  audio: boolean;
  max_viewers: number;
  decklink_input: boolean;
  /** The meeting helper streams its composited program over WebRTC (meeting_program_* commands). */
  meeting_preview?: boolean;
};

/**
 * Mode-driven Studio restoration (`mode_activate`)
 *
 * The web app's root page is the mode selection; the bridge learns the mode
 * only through this command and restores Studio connections (persisted engine,
 * persisted graphics output) for `studio` and `conference` only.
 */
export type BridgeModeT = "studio" | "meeting" | "conference";

/** What `mode_activate` triggered; outcomes arrive via `engine_status` / `graphics_status`. */
export type ModeActivationRestoreTargetT = "engine_autoconnect" | "graphics_output";

/**
 * `command_result.data` of `mode_activate`. Support is advertised as
 * `get_status.capabilities.mode_activation: true`; bridges without it restore
 * Studio state at startup on their own.
 */
export type ModeActivateResultT = {
  mode: BridgeModeT;
  restored: ModeActivationRestoreTargetT[];
};
