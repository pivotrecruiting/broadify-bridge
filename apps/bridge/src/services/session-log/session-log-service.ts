import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import { getRelayBridgeSigningIdentity } from "../relay-bridge-identity.js";
import { SessionEventRecorder } from "./session-event-recorder.js";
import { SessionLogUploader } from "./session-log-uploader.js";
import type { SwitcherEventT } from "./session-log-types.js";

const SESSION_LOG_DIR = "session-log";

let recorder: SessionEventRecorder | null = null;
let uploader: SessionLogUploader | null = null;

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
    const dir = path.join(context.userDataDir, SESSION_LOG_DIR);
    if (context.postproApiUrl && context.bridgeId) {
      uploader = new SessionLogUploader({
        apiBaseUrl: context.postproApiUrl,
        dir,
        getIdentity: getRelayBridgeSigningIdentity,
        logger: { info: (m) => context.logger.info(m), warn: (m) => context.logger.warn(m) },
      });
      void uploader.scan();
    }
    recorder = new SessionEventRecorder({
      dir,
      bridgeId: context.bridgeId ?? null,
      onSessionClosed: (sessionId) => {
        void uploader?.enqueue(sessionId);
      },
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
  uploader = null;
}
