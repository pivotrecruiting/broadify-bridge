/**
 * Ready-handshake budgets for the native output helpers.
 *
 * A helper must emit `{"type":"ready"}` within its budget or `configure()`
 * fails and the output transition rolls back. These values feed the serial
 * output-transition budget documented in
 * `docs/bridge/architecture/production-timeout-dataflows.md`.
 */

/** Display helper (SDL2 fullscreen window via FrameBus). */
export const DISPLAY_OUTPUT_HELPER_READY_TIMEOUT_MS = 8_000;

/** DeckLink helper (video-only and key/fill), includes device open + mode set. */
export const DECKLINK_OUTPUT_HELPER_READY_TIMEOUT_MS = 12_000;
