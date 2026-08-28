/**
 * Pure decision logic for renderer performance logging.
 *
 * Field analysis of the Windows meeting complaints (fans, latency) repeatedly
 * stalled on "no numbers from the field": perf logging was gated behind
 * BRIDGE_LOG_PERF, which no customer machine sets. The meeting planes now
 * always report, at a calm cadence; the env flag keeps its dense 1s cadence
 * for focused debugging sessions.
 */

const DEBUG_PERF_INTERVAL_MS = 1_000;
const MEETING_PERF_INTERVAL_MS = 5_000;

export type PerfLoggingDecisionT = {
  enabled: boolean;
  intervalMs: number;
};

/**
 * Decide whether and how often to emit renderer perf lines.
 *
 * @param logPerfEnv True when BRIDGE_LOG_PERF/debug explicitly enabled.
 * @param meetingBus True when the renderer serves a meeting graphics plane.
 * @returns Logging decision.
 */
export function resolvePerfLogging(
  logPerfEnv: boolean,
  meetingBus: boolean,
): PerfLoggingDecisionT {
  if (logPerfEnv) {
    return { enabled: true, intervalMs: DEBUG_PERF_INTERVAL_MS };
  }
  if (meetingBus) {
    return { enabled: true, intervalMs: MEETING_PERF_INTERVAL_MS };
  }
  return { enabled: false, intervalMs: DEBUG_PERF_INTERVAL_MS };
}
