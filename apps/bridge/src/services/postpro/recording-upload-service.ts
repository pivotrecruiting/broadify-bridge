import type {
  MeetingRecordingUploadStatusEventT,
  MeetingRecordingUploadStatusT,
} from "@broadify/protocol";
import { getBridgeContext } from "../bridge-context.js";
import { getRelayBridgeSigningIdentity } from "../relay-bridge-identity.js";
import { platformFetchFor } from "./platform-client.js";
import { createRecordingUploadPlatform } from "./recording-upload-platform.js";
import { recordingUploadQueueStore, recordingUploadSettingsStore } from "./recording-upload-store.js";
import { RecordingUploader } from "./recording-uploader.js";
import { TusUploadClient, readRecordingUploadMaxKbps } from "./tus-upload-client.js";

export const RECORDING_UPLOAD_STATUS_EVENT = "recording_upload_status";

const UNAVAILABLE_STATUS: MeetingRecordingUploadStatusT = {
  enabled: false,
  available: false,
  tasks: [],
  last_skipped: null,
};

let uploader: RecordingUploader | null = null;

/**
 * Whether this bridge can upload recordings (ADR-0011): it knows the
 * platform address (release configuration or operator override, never a
 * relay command) and has the bridge id its signing identity belongs to.
 * Reported as `capabilities.meeting.recording_upload`. False before the
 * bridge context exists.
 */
export function isRecordingUploadAvailable(): boolean {
  try {
    const context = getBridgeContext();
    return Boolean(context.platformApiUrl && context.bridgeId);
  } catch {
    return false;
  }
}

function publishStatus(upload: MeetingRecordingUploadStatusT): void {
  const data: MeetingRecordingUploadStatusEventT = { at: Date.now(), upload };
  getBridgeContext().publishBridgeEvent?.({ event: RECORDING_UPLOAD_STATUS_EVENT, data });
}

/**
 * Startup hook (server): creates the uploader when the bridge can upload,
 * settles recordings left over from the last run and arms the queue.
 * Nothing is sent to the platform until the web app pushed the opt-in.
 * No-op on a bridge that cannot upload.
 */
export async function initializeRecordingUpload(): Promise<void> {
  if (uploader || !isRecordingUploadAvailable()) {
    return;
  }
  const context = getBridgeContext();
  const created = new RecordingUploader({
    queueStore: recordingUploadQueueStore,
    settingsStore: recordingUploadSettingsStore,
    platform: createRecordingUploadPlatform({
      baseUrl: context.platformApiUrl ?? "",
      getIdentity: getRelayBridgeSigningIdentity,
      fetchFn: platformFetchFor(context.platformApiUrlGuarded === true),
    }),
    tus: new TusUploadClient({ maxKbps: readRecordingUploadMaxKbps() }),
    publish: publishStatus,
    logger: { info: (message) => context.logger.info(message), warn: (message) => context.logger.warn(message) },
  });
  uploader = created;
  await created.initialize();
}

/** Sink for every published meeting status: never throws, no-op on a bridge that cannot upload. */
export function noteMeetingStatusForRecordingUpload(status: Record<string, unknown>): void {
  uploader?.handleMeetingStatus(status);
}

/** Handler of `meeting_recording_upload_configure`: stores the opt-in hint and returns the snapshot. */
export async function configureRecordingUpload(enabled: boolean): Promise<MeetingRecordingUploadStatusT> {
  return uploader ? uploader.configure(enabled) : UNAVAILABLE_STATUS;
}

/** Shutdown hook (server): stops the request in flight; the queue resumes at the next start. */
export async function shutdownRecordingUpload(): Promise<void> {
  await uploader?.shutdown();
}

/** Test hook. */
export async function resetRecordingUploadForTests(): Promise<void> {
  await uploader?.shutdown();
  uploader = null;
}
