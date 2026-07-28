/**
 * Per-RPC timeouts for the native meeting-helper control channel.
 *
 * The flat 5 s default is wrong for the handful of RPCs whose legitimate
 * runtime is dominated by user interaction or media finalization:
 *
 * - recording.start waits up to 10 s for the OS microphone permission prompt
 *   before the writer is even built.
 * - recording.stop blocks in AVAssetWriter finishWriting / IMFSinkWriter
 *   Finalize for up to ~15 s on long recordings.
 * - control.shutdown finalizes an in-flight recording before it returns.
 * - keyer.configure may compile/load the segmentation model on first use.
 *
 * A client timeout below these values does not cancel the helper-side work —
 * it only makes the bridge report failure while the helper carries on
 * (invisible background recording, stream deck stuck on "REC").
 */
export const MEETING_HELPER_RPC_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  "recording.start": 15_000,
  "recording.stop": 20_000,
  "control.shutdown": 20_000,
  "keyer.configure": 15_000,
};
