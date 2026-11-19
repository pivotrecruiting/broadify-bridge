import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import { getRelayBridgeSigningIdentity } from "../relay-bridge-identity.js";
import { SessionEventRecorder } from "./session-event-recorder.js";
import { pruneSessionLogs } from "./session-log-retention.js";
import { SessionLogUploader } from "./session-log-uploader.js";
import type { SwitcherEventT } from "./session-log-types.js";

const SESSION_LOG_DIR = "session-log";

let recorder: SessionEventRecorder | null = null;
let uploader: SessionLogUploader | null = null;

/**
 * Single switch of the SessionEventLog feature (ADR-0008): on only when the
 * bridge was started with a post-production URL (`--postpro-api-url` /
 * `POSTPRO_API_URL`). Everything else (recorder, uploader, retention, the
 * adapters' extra polling and connections) hangs off this predicate. False
 * before the bridge context exists.
 */
export function isSessionLogEnabled(): boolean {
  try {
    return Boolean(getBridgeContext().postproApiUrl);
  } catch {
    return false;
  }
}

/**
 * Process-wide SessionEventLog recorder, created lazily from the bridge
 * context (<userData>/session-log). Returns null while the feature is off
 * (no directory, no timers) and before the context exists.
 */
export function getSessionEventRecorder(): SessionEventRecorder | null {
  if (recorder) {
    return recorder;
  }
  if (!isSessionLogEnabled()) {
    return null;
  }
  try {
    const context = getBridgeContext();
    const dir = path.join(context.userDataDir, SESSION_LOG_DIR);
    const prune = (): Promise<number> => pruneSessionLogs(dir, { isSessionOpen: (sessionId) => created.currentSessionId === sessionId });
    const created = new SessionEventRecorder({
      dir,
      bridgeId: context.bridgeId ?? null,
      onSessionClosed: (sessionId) => {
        void uploader?.enqueue(sessionId);
        void prune();
      },
    });
    recorder = created;
    // Never the URL: it may carry a preview-deployment host.
    context.logger.info("[SessionLog] enabled");
    if (context.postproApiUrl && context.bridgeId) {
      const createdUploader = new SessionLogUploader({
        apiBaseUrl: context.postproApiUrl,
        dir,
        getIdentity: getRelayBridgeSigningIdentity,
        logger: { info: (m) => context.logger.info(m), warn: (m) => context.logger.warn(m) },
        // The recorder may be opening a session on this very event: never upload a file still being written.
        isSessionOpen: (sessionId) => created.currentSessionId === sessionId,
        beforePeriodicScan: prune,
      });
      uploader = createdUploader;
      // Prune first so an expired leftover is dropped instead of uploaded.
      void prune().then(() => createdUploader.scan());
      createdUploader.startPeriodicScan();
    } else {
      context.logger.warn("[SessionLog] no bridge id (relay not enrolled): session logs stay local, no upload");
      void prune();
    }
    return recorder;
  } catch {
    return null;
  }
}

/**
 * Startup hook (server): creates the recorder when the feature is on so the
 * retention pass and the upload scan of leftovers run without waiting for
 * the first event. No-op while disabled.
 */
export function initializeSessionLog(): void {
  getSessionEventRecorder();
}

/** Hot-path safe sink for switcher adapters: never throws, no-op while disabled or without context. */
export function recordSwitcherEvent(event: SwitcherEventT): void {
  getSessionEventRecorder()?.record(event);
}

/** Test hook. */
export function resetSessionEventRecorderForTests(): void {
  uploader?.stopPeriodicScan();
  recorder = null;
  uploader = null;
}
