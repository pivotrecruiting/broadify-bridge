/** Timeout of every meeting-helper RPC without an entry in the table below. */
export const MEETING_HELPER_DEFAULT_RPC_TIMEOUT_MS = 5_000;

/**
 * Per-RPC timeouts for the native meeting-helper control channel.
 *
 * The flat 5 s default is wrong for the handful of RPCs whose legitimate
 * runtime is dominated by user interaction or media finalization:
 *
 * - recording.start waits up to 10 s for the OS microphone permission prompt
 *   before the writer is even built.
 * - recording.stop blocks in AVAssetWriter finishWriting / IMFSinkWriter
 *   Finalize for up to 15 s (kRecorderFinalizeTimeoutMs). The chain is
 *   finalize 15 s < this RPC 20 s < bridge-local SLA 30 s < relay timeout
 *   35 s of meeting_recording_stop / meeting_recording_toggle as declared in
 *   relay-command-policy.ts; scripts/meeting-helper-release-contract.test.cjs
 *   guards the order of these numbers. The relay timeout itself is enforced
 *   by the relay service and the web app, whose tables must follow it
 *   (docs/bridge/features/meeting-recording.md, "Finalize timeout").
 * - control.shutdown finalizes an in-flight recording before it returns.
 * - keyer.configure may compile/load the segmentation model on first use.
 * - camera.start first joins a possibly sleeping reopen-backoff thread and
 *   flushes the old capture session, then MediaFoundation device activation
 *   can block well past 5 s when another app (Teams/OBS) holds the device.
 * - camera.open_set does all of the above for several devices sequentially.
 *
 * A client timeout below these values does not cancel the helper-side work —
 * it only makes the bridge report failure while the helper carries on
 * (invisible background recording, stream deck stuck on "REC").
 */
export const MEETING_HELPER_RPC_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  "camera.start": 20_000,
  "camera.open_set": 25_000,
  "recording.start": 15_000,
  "recording.stop": 20_000,
  "control.shutdown": 20_000,
  "keyer.configure": 15_000,
  // The helper answers after its ICE gathering finished (bounded at 3 s).
  "program.viewer.offer": 8_000,
};
