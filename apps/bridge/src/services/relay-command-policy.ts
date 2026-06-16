import { RELAY_COMMAND_ALLOWLIST, type RelayCommand } from "./relay-command-allowlist.js";

export type RelayCommandTimeoutClassT =
  | "fast"
  | "engine_connect"
  | "list_outputs"
  | "graphics"
  | "helper_start";

export type RelayCommandExecutionModeT = "read_only" | "side_effect";
export type RelayCommandResponseModeT = "sync" | "async";
export type RelayCommandReplayPolicyT =
  | "always"
  | "same_request_id_only"
  | "after_state_check"
  | "never";
export type RelayCommandResourceConflictPolicyT =
  | "reject"
  | "join_existing"
  | "queue";

export type RelayCommandPolicyT = {
  command: RelayCommand;
  executionMode: RelayCommandExecutionModeT;
  timeoutClass: RelayCommandTimeoutClassT;
  relayTimeoutMs: number;
  bridgeLocalSlaMs: number;
  replayable: boolean;
  concurrencyKey: string;
  invalidates: string[];
  replayPolicy: RelayCommandReplayPolicyT;
  responseMode: RelayCommandResponseModeT;
  resourceConflictPolicy: RelayCommandResourceConflictPolicyT;
};

const FAST_RELAY_TIMEOUT_MS = 12_000;
const FAST_BRIDGE_LOCAL_SLA_MS = 8_000;

const readOnly = (
  command: RelayCommand,
  timeoutClass: RelayCommandTimeoutClassT,
  relayTimeoutMs: number,
  bridgeLocalSlaMs: number,
  invalidates: string[],
): RelayCommandPolicyT => ({
  command,
  executionMode: "read_only",
  timeoutClass,
  relayTimeoutMs,
  bridgeLocalSlaMs,
  replayable: true,
  concurrencyKey: "read_only",
  invalidates,
  replayPolicy: "always",
  responseMode: "sync",
  resourceConflictPolicy: "queue",
});

const sideEffect = (
  command: RelayCommand,
  timeoutClass: RelayCommandTimeoutClassT,
  relayTimeoutMs: number,
  bridgeLocalSlaMs: number,
  concurrencyKey: string,
  invalidates: string[],
  replayPolicy: RelayCommandReplayPolicyT = "same_request_id_only",
  responseMode: RelayCommandResponseModeT = "sync",
  resourceConflictPolicy: RelayCommandResourceConflictPolicyT = "queue",
): RelayCommandPolicyT => ({
  command,
  executionMode: "side_effect",
  timeoutClass,
  relayTimeoutMs,
  bridgeLocalSlaMs,
  replayable: replayPolicy !== "never",
  concurrencyKey,
  invalidates,
  replayPolicy,
  responseMode,
  resourceConflictPolicy,
});

const RELAY_COMMAND_POLICY: Record<RelayCommand, RelayCommandPolicyT> = {
  get_status: readOnly("get_status", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["bridge.status"]),
  bridge_pair_validate: readOnly("bridge_pair_validate", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["bridge.identity"]),
  list_outputs: readOnly("list_outputs", "list_outputs", 15_000, 11_000, ["outputs"]),
  engine_connect: sideEffect("engine_connect", "engine_connect", 18_000, 11_000, "engine", ["engine.status"], "after_state_check"),
  engine_disconnect: sideEffect("engine_disconnect", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "engine", ["engine.status"], "after_state_check"),
  engine_get_status: readOnly("engine_get_status", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["engine.status"]),
  engine_get_macros: readOnly("engine_get_macros", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["engine.macros"]),
  engine_run_macro: sideEffect("engine_run_macro", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "engine", ["engine.status"]),
  engine_stop_macro: sideEffect("engine_stop_macro", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "engine", ["engine.status"]),
  engine_vmix_run_action: sideEffect("engine_vmix_run_action", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "engine", ["engine.status"]),
  engine_vmix_ensure_browser_input: sideEffect("engine_vmix_ensure_browser_input", "helper_start", 35_000, 30_000, "engine", ["engine.status", "graphics"], "after_state_check", "async", "join_existing"),
  graphics_configure_outputs: sideEffect("graphics_configure_outputs", "graphics", 20_000, 16_000, "graphics", ["graphics", "outputs"]),
  graphics_send: sideEffect("graphics_send", "graphics", 20_000, 16_000, "graphics", ["graphics"]),
  graphics_test_pattern: sideEffect("graphics_test_pattern", "graphics", 20_000, 16_000, "graphics", ["graphics"]),
  graphics_update_values: sideEffect("graphics_update_values", "graphics", 20_000, 16_000, "graphics", ["graphics"]),
  graphics_update_layout: sideEffect("graphics_update_layout", "graphics", 20_000, 16_000, "graphics", ["graphics"]),
  graphics_remove: sideEffect("graphics_remove", "graphics", 20_000, 16_000, "graphics", ["graphics"]),
  graphics_remove_preset: sideEffect("graphics_remove_preset", "graphics", 20_000, 16_000, "graphics", ["graphics"]),
  graphics_list: readOnly("graphics_list", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["graphics"]),
  meeting_get_state: readOnly("meeting_get_state", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["meeting.state"]),
  meeting_engine_start: sideEffect("meeting_engine_start", "helper_start", 35_000, 30_000, "meeting.engine", ["meeting.engine"], "after_state_check", "async", "join_existing"),
  meeting_engine_stop: sideEffect("meeting_engine_stop", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.engine", ["meeting.engine"], "after_state_check"),
  meeting_camera_list: readOnly("meeting_camera_list", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["meeting.camera"]),
  meeting_camera_select: sideEffect("meeting_camera_select", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.camera", ["meeting.camera"]),
  meeting_camera_start: sideEffect("meeting_camera_start", "helper_start", 35_000, 30_000, "meeting.camera", ["meeting.camera"], "after_state_check", "async", "join_existing"),
  meeting_camera_stop: sideEffect("meeting_camera_stop", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.camera", ["meeting.camera"], "after_state_check"),
  meeting_keyer_get: readOnly("meeting_keyer_get", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["meeting.keyer"]),
  meeting_keyer_configure: sideEffect("meeting_keyer_configure", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.keyer", ["meeting.keyer"]),
  meeting_keyer_reset: sideEffect("meeting_keyer_reset", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.keyer", ["meeting.keyer"], "after_state_check"),
  meeting_program_get: readOnly("meeting_program_get", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["meeting.program"]),
  meeting_program_update: sideEffect("meeting_program_update", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.program", ["meeting.program"]),
  meeting_button_list: readOnly("meeting_button_list", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, ["meeting.buttons"]),
  meeting_button_trigger: sideEffect("meeting_button_trigger", "fast", FAST_RELAY_TIMEOUT_MS, FAST_BRIDGE_LOCAL_SLA_MS, "meeting.engine", ["meeting.program"]),
  meeting_output_configure: sideEffect("meeting_output_configure", "graphics", 20_000, 16_000, "meeting.graphics", ["meeting.graphics", "outputs"]),
  meeting_graphics_configure_outputs: sideEffect("meeting_graphics_configure_outputs", "graphics", 20_000, 16_000, "meeting.graphics", ["meeting.graphics", "outputs"]),
};

/**
 * Returns the production command policy used by the bridge relay client.
 */
export const getRelayCommandPolicy = (
  command: RelayCommand,
): RelayCommandPolicyT => RELAY_COMMAND_POLICY[command];

/**
 * Exposes a complete policy snapshot for tests and documentation tooling.
 */
export const getRelayCommandPolicies = (): RelayCommandPolicyT[] =>
  RELAY_COMMAND_ALLOWLIST.map((command) => RELAY_COMMAND_POLICY[command]);
