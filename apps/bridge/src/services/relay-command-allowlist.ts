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
