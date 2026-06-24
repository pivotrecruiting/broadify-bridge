/**
 * Relay command allowlist accepted by the bridge.
 */
export const RELAY_COMMAND_ALLOWLIST = [
  "get_status",
  "bridge_pair_validate",
  "list_outputs",
  "engine_connect",
  "engine_disconnect",
  "engine_get_status",
  "engine_get_macros",
  "engine_run_macro",
  "engine_stop_macro",
  "engine_vmix_run_action",
  "engine_vmix_ensure_browser_input",
  "graphics_configure_outputs",
  "graphics_send",
  "graphics_test_pattern",
  "graphics_update_values",
  "graphics_update_layout",
  "graphics_remove",
  "graphics_remove_preset",
  "graphics_list",
  "meeting_get_state",
  "meeting_engine_start",
  "meeting_engine_stop",
  "meeting_camera_list",
  "meeting_camera_select",
  "meeting_camera_start",
  "meeting_camera_stop",
  "meeting_keyer_get",
  "meeting_keyer_configure",
  "meeting_keyer_reset",
  "meeting_program_get",
  "meeting_program_update",
  "meeting_output_configure",
  "meeting_graphics_configure_outputs",
  "canon_xc_list_devices",
  "canon_xc_save_device",
  "canon_xc_test_connection",
  "canon_xc_delete_device",
  "canon_xc_test_device",
  "canon_xc_list_presets",
  "canon_xc_recall_preset",
] as const;

const RELAY_COMMAND_ALLOWLIST_SET = new Set<string>(RELAY_COMMAND_ALLOWLIST);

/**
 * Relay command types accepted by the bridge.
 */
export type RelayCommand = (typeof RELAY_COMMAND_ALLOWLIST)[number];

/**
 * Runtime allowlist check for relay commands.
 */
export const isRelayCommand = (value: unknown): value is RelayCommand => {
  return typeof value === "string" && RELAY_COMMAND_ALLOWLIST_SET.has(value);
};
