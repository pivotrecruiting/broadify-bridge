/**
 * Shutdown time budgets shared by the desktop main process, the bridge
 * process manager and the app updater.
 *
 * Invariant: BRIDGE_STOP_GRACE_MS < APP_SHUTDOWN_TIMEOUT_MS < INSTALL_CLEANUP_TIMEOUT_MS
 *
 * - BRIDGE_STOP_GRACE_MS is the time the bridge child gets after SIGTERM
 *   before its process group is SIGKILLed. It is deliberately NOT shortened
 *   on quit or install: the bridge's graceful shutdown finalizes an in-flight
 *   meeting recording (its meeting stop step waits up to ~22 s for
 *   recording.stop + control.shutdown, see apps/bridge/src/server.ts). A
 *   SIGKILL any earlier destroys the MP4 mid-finalization. Without a
 *   recording the whole chain completes in about a second.
 * - APP_SHUTDOWN_TIMEOUT_MS races the complete app cleanup (updater timers,
 *   health polling, bridge stop). It must exceed the bridge stop grace so the
 *   forced app exit never pre-empts a bridge that is still finalizing.
 * - INSTALL_CLEANUP_TIMEOUT_MS is the updater's own upper bound for the
 *   pre-install hook, which runs that same app cleanup. It exceeds the app
 *   shutdown timeout by a margin so the hook's timeout (which also releases
 *   the quit guard) always fires first; the updater's race is a last resort
 *   that only guards against a hook that never returns at all.
 */
export const BRIDGE_STOP_GRACE_MS = 25_000;
export const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
export const INSTALL_CLEANUP_TIMEOUT_MS = APP_SHUTDOWN_TIMEOUT_MS + 5_000;
