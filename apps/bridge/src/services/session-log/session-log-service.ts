import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import { SessionEventRecorder } from "./session-event-recorder.js";
import type { SwitcherEventT } from "./session-log-types.js";

const SESSION_LOG_DIR = "session-log";

let recorder: SessionEventRecorder | null = null;

/**
 * Process-wide SessionEventLog recorder, created lazily from the bridge
 * context (<userData>/session-log). Returns null before the context exists.
 */
export function getSessionEventRecorder(): SessionEventRecorder | null {
  if (recorder) {
    return recorder;
  }
  try {
    const context = getBridgeContext();
    recorder = new SessionEventRecorder({
      dir: path.join(context.userDataDir, SESSION_LOG_DIR),
      bridgeId: context.bridgeId ?? null,
    });
    return recorder;
  } catch {
    return null;
  }
}

/** Hot-path safe sink for switcher adapters: never throws, no-op without context. */
export function recordSwitcherEvent(event: SwitcherEventT): void {
  getSessionEventRecorder()?.record(event);
}

/** Test hook. */
export function resetSessionEventRecorderForTests(): void {
  recorder = null;
}
