/**
 * Publish policy for the periodic meeting status snapshot.
 *
 * The helper status carries per-frame counters (rendered/reused frame
 * counts, keyer timing metrics, ...) that change on every poll, so a naive
 * "publish when the JSON changed" dedupe never fires and every 2 s poll
 * turns into a relay event. This module decides whether a snapshot is worth
 * publishing based on a stable projection that ignores those counters.
 *
 * Rules (explicit on purpose - never silently starve a consumer):
 *  1. `force === true` always publishes (lifecycle transitions, recording
 *     start/stop, resync).
 *  2. While `recording.active` is true every poll publishes, because the
 *     webapp renders `elapsed_seconds` / `video_frames` as a live timer.
 *  3. A change in the stable projection (anything that is not a per-frame
 *     counter, e.g. camera index, keyer provider, fallback flags, errors,
 *     vcam state) publishes immediately.
 *  4. Otherwise the snapshot is still published at least every
 *     `STATUS_METRICS_PUBLISH_INTERVAL_MS` so performance panels that show
 *     the counters/metrics keep moving, just at a throttled cadence.
 */

/** Minimum cadence at which counter-only changes reach the webapp. */
export const STATUS_METRICS_PUBLISH_INTERVAL_MS = 6000;

/**
 * Keys (at any nesting level) that are pure per-frame counters or timings
 * and must not count as a meaningful status change on their own.
 */
const VOLATILE_COUNTER_KEYS: ReadonlySet<string> = new Set([
  "rendered_frames",
  "reused_frames",
  "published_preview_frames",
  "written_framebus_frames",
  "inference_ms",
  "elapsed_seconds",
  "video_frames",
]);

export type StatusPublishDecisionInputT = {
  status: Record<string, unknown>;
  force: boolean;
  /** Projection key of the last published snapshot (null before the first). */
  lastProjection: string | null;
  /** Wall-clock time of the last publish (null before the first). */
  lastPublishedAt: number | null;
  now: number;
  metricsIntervalMs?: number;
};

export type StatusPublishReasonT =
  | "forced"
  | "recording_active"
  | "projection_changed"
  | "metrics_interval"
  | "unchanged";

export type StatusPublishDecisionT = {
  publish: boolean;
  reason: StatusPublishReasonT;
  /** Projection key to remember when the snapshot is published. */
  projection: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (VOLATILE_COUNTER_KEYS.has(key)) {
      continue;
    }
    out[key] = stripVolatile(entry);
  }
  return out;
}

/**
 * Returns a serialized projection of the status without per-frame counters
 * and without `keyer.status.metrics`. Two snapshots with the same projection
 * differ only in counters/metrics.
 */
export function projectStableStatus(status: Record<string, unknown>): string {
  const projected = stripVolatile(status) as Record<string, unknown>;
  const keyer = projected.keyer;
  if (isPlainObject(keyer) && isPlainObject(keyer.status)) {
    const { metrics: _metrics, ...rest } = keyer.status;
    projected.keyer = { ...keyer, status: rest };
  }
  return JSON.stringify(projected);
}

/** True when the snapshot reports an active recording. */
export function isRecordingActive(status: Record<string, unknown>): boolean {
  const recording = status.recording;
  return isPlainObject(recording) && recording.active === true;
}

/**
 * Applies the publish rules documented at the top of this file.
 */
export function decideStatusPublish(
  input: StatusPublishDecisionInputT,
): StatusPublishDecisionT {
  const projection = projectStableStatus(input.status);
  const intervalMs = input.metricsIntervalMs ?? STATUS_METRICS_PUBLISH_INTERVAL_MS;
  if (input.force) {
    return { publish: true, reason: "forced", projection };
  }
  if (isRecordingActive(input.status)) {
    return { publish: true, reason: "recording_active", projection };
  }
  if (input.lastProjection === null || projection !== input.lastProjection) {
    return { publish: true, reason: "projection_changed", projection };
  }
  if (
    input.lastPublishedAt === null ||
    input.now - input.lastPublishedAt >= intervalMs
  ) {
    return { publish: true, reason: "metrics_interval", projection };
  }
  return { publish: false, reason: "unchanged", projection };
}
