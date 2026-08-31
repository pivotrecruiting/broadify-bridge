import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseRelayPayload,
  EmptyPayloadSchema,
} from "../relay-command-schemas.js";
import {
  ConferenceDisplayStartSchema,
  MeetingCameraSelectionSchema,
  MeetingBackgroundImageFetchSchema,
  MeetingBrowserSourceSetSchema,
  MeetingCallControlSchema,
  MeetingContentVideoSetSchema,
  MeetingEngineStartSchema,
  MeetingGraphicsConfigureOutputsSchema,
  MeetingKeyerConfigureSchema,
  MeetingMediaFetchSchema,
  MeetingMediaGetSchema,
  MeetingOutputConfigureSchema,
  MeetingPassthroughSchema,
  MeetingProgramUpdateSchema,
  MeetingRecordingStartSchema,
} from "./meeting-command-schemas.js";
import {
  meetingMediaService,
  videoMimeForFilename,
} from "./meeting-media-service.js";
import {
  MEETING_BROWSER_SOURCE_LAYER_ID,
  MEETING_CONTENT_VIDEO_LAYER_ID,
  buildBrowserSourceLayerHtml,
  buildVideoLayerHtml,
  validateBrowserSourceUrl,
} from "./meeting-content-layers.js";
import { getBridgeContext } from "../bridge-context.js";
import { openGuardedDownload } from "./media-download.js";
import { fetchBackgroundImage } from "./background-image-store.js";
import { ConferenceDisplayOutput } from "../conference/conference-display-output.js";
import {
  conferenceDirectorService,
  parseDirectorConfigPatch,
  parseInjectReading,
} from "../conference/director/conference-director-service.js";
import { meetingHelperManager } from "./meeting-helper-manager.js";
import { mapVcamStartError } from "./vcam-error-mapper.js";
import { publishMeetingErrorEvent } from "./meeting-event-publisher.js";
import {
  executeMeetingCallControl,
  MeetingCallControlError,
} from "./meeting-call-control.js";
import { pickRecordingSavePath } from "./meeting-recording-dialog.js";
import {
  MeetingHelperRequestError,
  type MeetingHelperClient,
} from "./meeting-helper-client.js";
import {
  MEETING_GRAPHICS_BACK_FRAMEBUS_NAME,
  MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME,
  MEETING_GRAPHICS_FRAMEBUS_SLOT_COUNT,
  meetingBackGraphicsManager,
  meetingFrontGraphicsManager,
} from "./meeting-graphics-manager.js";
import { loadFrameBusModule } from "../graphics/framebus/framebus-client.js";

/** Reads `recording.active` out of a recording.* RPC result, default false. */
function isRecordingActive(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const recording = (data as Record<string, unknown>).recording;
  if (!recording || typeof recording !== "object") {
    return false;
  }
  return (recording as Record<string, unknown>).active === true;
}

export type MeetingCommandResultT = {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
};

const ENGINE_NOT_RUNNING_ERROR =
  "Meeting engine is not running. Start it with meeting_engine_start first.";
const MEETING_GRAPHICS_FRAMEBUS_NAMES = [
  MEETING_GRAPHICS_BACK_FRAMEBUS_NAME,
  MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME,
];
const DEFAULT_MEETING_GRAPHICS_FORMAT = { width: 1920, height: 1080, fps: 30 };
const MEETING_GRAPHICS_SLOT_COUNT = MEETING_GRAPHICS_FRAMEBUS_SLOT_COUNT;
const MEETING_GRAPHICS_PIXEL_FORMAT = 1;

function requireClient(): MeetingHelperClient {
  const client = meetingHelperManager.getClient();
  if (!client || !meetingHelperManager.isRunning()) {
    throw new Error(ENGINE_NOT_RUNNING_ERROR);
  }
  return client;
}

/**
 * Configures the back/front meeting graphics outputs. Idempotent: repeated
 * calls with an unchanged format are no-ops, so toggling a background in the
 * builder does not re-run the full atomic output transition every time.
 * Spawning the Electron renderers (cold start of several seconds) happens on
 * the first call — which is why meeting_engine_start pre-warms this.
 *
 * Calls are strictly serialized through a queue: the pre-warm and the web
 * app command can otherwise run concurrently, and both mutate the global
 * BRIDGE_FRAMEBUS_* env vars that the renderers read on spawn — a race would
 * point a renderer at the wrong FrameBus.
 */
let lastConfiguredGraphicsOutputsKey: string | null = null;
let pendingGraphicsOutputsKey: string | null = null;
let graphicsOutputsQueue: Promise<void> = Promise.resolve();

type ConfigureGraphicsOutputsResultT = {
  completion: Promise<void>;
  /**
   * True when the same config is already applied or currently being applied
   * (e.g. by the engine-start pre-warm). Callers with a command timeout must
   * NOT await `completion` in that case — a renderer cold start can take
   * longer than the relay timeout, and the work finishes regardless.
   */
  alreadySatisfiedOrPending: boolean;
};

function configureMeetingGraphicsOutputs(
  width: number,
  height: number,
  fps: number,
): ConfigureGraphicsOutputsResultT {
  const configKey = `${width}x${height}@${fps}`;
  const alreadySatisfiedOrPending =
    lastConfiguredGraphicsOutputsKey === configKey || pendingGraphicsOutputsKey === configKey;
  pendingGraphicsOutputsKey = configKey;
  const run = graphicsOutputsQueue.then(async () => {
    if (lastConfiguredGraphicsOutputsKey === configKey) {
      return;
    }
    // Belt & braces: the managers now carry their bus name/slotCount as
    // explicit constructor overrides (meeting-graphics-manager.ts), which win
    // over these env vars in every resolve. The env sets are kept anyway
    // because other meeting-path consumers still read the ambient env on
    // spawn (e.g. the renderer child's initial BRIDGE_FRAMEBUS_NAME before
    // its first renderer_configure) — removing them is a follow-up once those
    // consumers are audited one by one.
    process.env.BRIDGE_FRAMEBUS_NAME = MEETING_GRAPHICS_BACK_FRAMEBUS_NAME;
    process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = String(
      MEETING_GRAPHICS_SLOT_COUNT,
    );
    process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "1";
    await meetingBackGraphicsManager.configureOutputs({
      outputKey: "framebus",
      targets: {},
      format: { width, height, fps },
      range: "full",
      colorspace: "rec709",
    });
    process.env.BRIDGE_FRAMEBUS_NAME = MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME;
    process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = String(
      MEETING_GRAPHICS_SLOT_COUNT,
    );
    process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "1";
    await meetingFrontGraphicsManager.configureOutputs({
      outputKey: "framebus",
      targets: {},
      format: { width, height, fps },
      range: "full",
      colorspace: "rec709",
    });
    lastConfiguredGraphicsOutputsKey = configKey;
  });
  // Keep the queue alive even if this run fails; the failure still surfaces
  // to the caller through `completion`.
  graphicsOutputsQueue = run
    .catch(() => {})
    .finally(() => {
      if (pendingGraphicsOutputsKey === configKey) {
        pendingGraphicsOutputsKey = null;
      }
    });
  return { completion: run, alreadySatisfiedOrPending };
}

/**
 * Best-effort virtual-camera arm after a successful engine start. Runs in
 * the background; failures are published as meeting error events with the
 * stable vcam error codes so the UI can show actionable guidance without
 * blocking the engine start itself. Unattended: the Windows registration
 * self-heal may diagnose but never raise a UAC prompt from here; only the
 * explicit `meeting_output_configure` start does.
 */
function autoArmVirtualCamera(): void {
  void (async () => {
    try {
      const client = requireClient();
      await client.virtualCameraStart({ allowElevation: false });
      meetingHelperManager.noteVirtualCameraStarted();
      console.info("[meeting] virtual camera auto-armed with engine start");
    } catch (error: unknown) {
      // A background arm must never take the process down — not even when
      // the event publisher itself is unavailable (tests, early shutdown).
      try {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const mapped = mapVcamStartError(rawMessage);
        publishMeetingErrorEvent(mapped.errorCode, mapped.error);
        console.warn(`[meeting] virtual camera auto-arm failed: ${mapped.error}`);
      } catch {
        console.warn("[meeting] virtual camera auto-arm failed (unreportable)");
      }
    }
  })();
}

async function runMeetingRpc<T>(operation: () => Promise<T>): Promise<MeetingCommandResultT> {
  try {
    return { success: true, data: await operation() };
  } catch (error: unknown) {
    if (error instanceof MeetingHelperRequestError) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code,
      };
    }
    throw error;
  }
}

/**
 * Native recorder failure tokens the webapp maps to localized messages. The
 * helper reports them as the error MESSAGE under the generic RPC code
 * `recording_start_failed`; promoting a known token to the errorCode gives the
 * webapp a stable machine-readable code without a helper rebuild.
 */
const RECORDING_ERROR_TOKENS = new Set([
  "microphone_permission_denied",
  "microphone_not_found",
  "microphone_input_failed",
  "microphone_input_rejected",
  "disk_full",
  "writer_create_failed",
  "already_recording",
  "invalid_arguments",
]);

function normalizeRecordingErrorCode(
  result: MeetingCommandResultT,
): MeetingCommandResultT {
  if (
    !result.success &&
    typeof result.error === "string" &&
    RECORDING_ERROR_TOKENS.has(result.error)
  ) {
    return { ...result, errorCode: result.error };
  }
  return result;
}

async function listCamerasWithPermissionGate(): Promise<unknown> {
  const client = requireClient();
  const state = await client.getState();
  const permissionStatus =
    typeof state.camera_permission_status === "string"
      ? state.camera_permission_status
      : "unknown";
  if (
    permissionStatus === "prompt_requested" ||
    permissionStatus === "not_determined"
  ) {
    throw new MeetingHelperRequestError(
      "camera_permission_pending",
      "Camera permission request is still pending.",
    );
  }
  return client.listCameras();
}

function clearMeetingGraphicsFrameBus(
  format: { width?: number; height?: number; fps?: number },
  reason: string,
): void {
  try {
    const width = format.width ?? DEFAULT_MEETING_GRAPHICS_FORMAT.width;
    const height = format.height ?? DEFAULT_MEETING_GRAPHICS_FORMAT.height;
    const fps = format.fps ?? DEFAULT_MEETING_GRAPHICS_FORMAT.fps;
    const module = loadFrameBusModule();
    if (!module) {
      throw new Error("FrameBus module not loaded");
    }
    for (const framebusName of MEETING_GRAPHICS_FRAMEBUS_NAMES) {
      const writer = module.createWriter({
        name: framebusName,
        width,
        height,
        fps,
        pixelFormat: MEETING_GRAPHICS_PIXEL_FORMAT,
        slotCount: MEETING_GRAPHICS_SLOT_COUNT,
        forceRecreate: true,
      });
      writer.writeFrame(Buffer.alloc(width * height * 4, 0));
      writer.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Meeting] Could not clear meeting graphics FrameBus (${reason}): ${message}`,
    );
  }
}

/**
 * Check whether a command is a meeting command.
 */
export function isMeetingCommand(command: string): boolean {
  return command.startsWith("meeting_") || command.startsWith("conference_");
}

/**
 * Conference display output. Shares the meeting program FrameBus, so it lives
 * alongside the meeting command handler. Single instance per bridge process.
 */
const conferenceDisplayOutput = new ConferenceDisplayOutput();

// The auto-director cuts the program feed via the meeting helper's seamless
// camera.program_select. It only fires while the engine is running.
conferenceDirectorService.setSwitcher(async (cameraIndex) => {
  const client = meetingHelperManager.getClient();
  if (client && meetingHelperManager.isRunning()) {
    await client.cameraProgramSelect({ camera_index: cameraIndex });
  }
});

/**
 * Handle a meeting_* relay command by delegating to the engine manager
 * or the native meeting-helper JSON-RPC API.
 *
 * @param command Allowlisted meeting command name.
 * @param payload Untrusted payload, validated per command.
 * @returns Command execution result.
 */
export async function handleMeetingCommand(
  command: string,
  payload?: Record<string, unknown>,
): Promise<MeetingCommandResultT> {
  switch (command) {
    case "meeting_get_state": {
      parseRelayPayload(
        EmptyPayloadSchema,
        payload ?? {},
        "Invalid payload for meeting_get_state",
      );
      return {
        success: true,
        data: await meetingHelperManager.getFullStatus(),
      };
    }

    case "meeting_engine_start": {
      const options = parseRelayPayload(
        MeetingEngineStartSchema,
        payload ?? {},
        "Invalid payload for meeting_engine_start",
      );
      if (meetingHelperManager.isRunning()) {
        // Idempotent re-start (e.g. a second webapp client's autostart while
        // the engine is live): do NOT clear the graphics FrameBus - the
        // force-recreate would yank the regions out from under the running
        // helper and every renderer, killing on-air graphics.
        return { success: true, data: meetingHelperManager.getStatus() };
      }
      clearMeetingGraphicsFrameBus(options, "engine_start");
      // The clear force-recreated the bus regions. Any already-running
      // renderer still maps the unlinked old regions - without an explicit
      // re-attach every graphics frame it writes from now on is invisible to
      // the fresh helper (observed live: presets gone after the 2nd engine
      // start in one bridge run).
      meetingBackGraphicsManager.invalidateRendererFrameBusAttachment();
      meetingFrontGraphicsManager.invalidateRendererFrameBusAttachment();
      // Reset through the queue so an in-flight configure cannot overwrite
      // the reset with its stale key afterwards.
      graphicsOutputsQueue = graphicsOutputsQueue
        .then(() => {
          lastConfiguredGraphicsOutputsKey = null;
        })
        .catch(() => {});
      const status = await meetingHelperManager.start(options);
      if (status.state !== "running") {
        return {
          success: false,
          error: status.lastError || "Meeting engine failed to start",
          data: status,
        };
      }
      // Pre-warm the graphics renderers in the background: the Electron
      // processes take seconds to spawn, and doing it now means toggling a
      // background later only costs a layer send instead of a cold start.
      // Format must match what the web app sends (MEETING_GRAPHICS_FORMAT,
      // 1920x1080@30) so the later configure call is a cache hit.
      // Auto-arm the virtual camera with the engine so "Broadify Camera"
      // exists in Teams/Zoom without the live-test click. Fire-and-forget:
      // failures surface as meeting error events with the stable vcam codes
      // (W1) instead of failing the engine start.
      autoArmVirtualCamera();
      configureMeetingGraphicsOutputs(1920, 1080, 30).completion.catch((error: unknown) => {
        console.warn(
          `[meeting] graphics renderer pre-warm failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return { success: true, data: status };
    }

    case "meeting_engine_stop": {
      parseRelayPayload(
        EmptyPayloadSchema,
        payload ?? {},
        "Invalid payload for meeting_engine_stop",
      );
      return { success: true, data: await meetingHelperManager.stop() };
    }

    case "meeting_camera_list": {
      return runMeetingRpc(() => listCamerasWithPermissionGate());
    }

    case "meeting_camera_select": {
      const options = parseRelayPayload(
        MeetingCameraSelectionSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_select",
      );
      const result = await runMeetingRpc(() =>
        requireClient().cameraSelect(options),
      );
      if (result.success) {
        meetingHelperManager.noteCameraCall("cameraSelect", options);
      }
      return result;
    }

    case "meeting_camera_start": {
      const options = parseRelayPayload(
        MeetingCameraSelectionSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_start",
      );
      const result = await runMeetingRpc(() =>
        requireClient().cameraStart(options),
      );
      if (result.success) {
        meetingHelperManager.noteCameraCall("cameraStart", options);
      }
      return result;
    }

    case "meeting_camera_stop": {
      const result = await runMeetingRpc(() => requireClient().cameraStop());
      if (result.success) {
        meetingHelperManager.noteCameraStopped();
      }
      return result;
    }

    case "meeting_camera_open_set": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_open_set",
      );
      const result = await runMeetingRpc(() =>
        requireClient().cameraOpenSet(options),
      );
      if (result.success) {
        meetingHelperManager.noteCameraCall("cameraOpenSet", options);
      }
      return result;
    }

    case "meeting_camera_program_select": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_program_select",
      );
      const result = await runMeetingRpc(() =>
        requireClient().cameraProgramSelect(options),
      );
      if (result.success) {
        meetingHelperManager.noteCameraCall("cameraProgramSelect", options);
      }
      return result;
    }

    case "meeting_camera_pip_set": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_pip_set",
      );
      const result = await runMeetingRpc(() =>
        requireClient().cameraPipSet(options),
      );
      if (result.success) {
        meetingHelperManager.noteCameraCall("cameraPipSet", options);
      }
      return result;
    }

    case "meeting_camera_audio_levels": {
      return runMeetingRpc(() => requireClient().cameraAudioLevels());
    }

    case "meeting_camera_auto_director": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_auto_director",
      );
      const result = await runMeetingRpc(() =>
        requireClient().cameraAutoDirector(options),
      );
      if (result.success) {
        meetingHelperManager.noteCameraCall("cameraAutoDirector", options);
      }
      return result;
    }

    case "meeting_recording_microphones": {
      return runMeetingRpc(() => requireClient().recordingMicrophones());
    }

    case "meeting_recording_pick_path": {
      // Bridge-local: the file is written on this machine by the helper, so the
      // save location is chosen here via the native macOS panel, not in the
      // browser. Returns { cancelled: true } when the user dismisses the panel.
      const defaultName =
        typeof payload?.default_name === "string"
          ? payload.default_name
          : "meeting.mp4";
      const locale =
        typeof payload?.locale === "string" ? payload.locale : "de";
      const filePath = await pickRecordingSavePath(defaultName, locale);
      if (filePath === null) {
        return { success: true, data: { cancelled: true } };
      }
      return { success: true, data: { cancelled: false, file_path: filePath } };
    }

    case "meeting_recording_start": {
      const options = parseRelayPayload(
        MeetingRecordingStartSchema,
        payload ?? {},
        "Invalid payload for meeting_recording_start",
      );
      const result = await runMeetingRpc(() =>
        requireClient().recordingStart(options),
      );
      if (result.success) {
        // The status publisher is the single writer of the deck's REC mirror
        // and of the pushed meeting_status snapshot (audit SD-04/WP-2.4).
        meetingHelperManager.notifyRecordingChanged();
      }
      return normalizeRecordingErrorCode(result);
    }

    case "meeting_recording_stop": {
      const result = await runMeetingRpc(() => requireClient().recordingStop());
      if (result.success) {
        meetingHelperManager.notifyRecordingChanged();
      }
      return result;
    }

    case "meeting_recording_toggle": {
      // One-key start/stop (Stream Deck). Unlike meeting_recording_start there
      // is no save dialog: the file goes to a fixed recordings folder with a
      // timestamped name.
      const client = requireClient();
      const status = await runMeetingRpc(() => client.recordingStatus());
      const active = isRecordingActive(status.data);
      if (active) {
        const stopped = await runMeetingRpc(() => client.recordingStop());
        if (stopped.success) {
          meetingHelperManager.notifyRecordingChanged();
        }
        return stopped;
      }
      const recordingsDir = path.join(
        os.homedir(),
        "Videos",
        "Broadify Recordings",
      );
      await mkdir(recordingsDir, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const filePath = path.join(recordingsDir, `meeting-${stamp}.mp4`);
      const micDeviceId =
        typeof payload?.mic_device_id === "string" ? payload.mic_device_id : "";
      const started = await runMeetingRpc(() =>
        client.recordingStart({
          file_path: filePath,
          mic_device_id: micDeviceId,
        }),
      );
      if (started.success) {
        meetingHelperManager.notifyRecordingChanged();
      }
      return normalizeRecordingErrorCode(started);
    }

    case "meeting_recording_status": {
      return runMeetingRpc(() => requireClient().recordingStatus());
    }

    // Cloud-fetch commands: HTTPS webapps cannot POST files to the local
    // bridge in every browser (Safari blocks active mixed content to
    // 127.0.0.1), so the webapp sends a cloud URL and the bridge downloads
    // the asset itself through the guarded downloader.
    case "meeting_background_image_fetch": {
      const { url } = parseRelayPayload(
        MeetingBackgroundImageFetchSchema,
        payload ?? {},
        "Invalid payload for meeting_background_image_fetch",
      );
      // Cached per URL path (query/signature stripped) with conditional
      // revalidation; see background-image-store.ts.
      const { path, cached } = await fetchBackgroundImage(url);
      return { success: true, data: { path, cached } };
    }

    case "meeting_media_fetch": {
      const { url, name } = parseRelayPayload(
        MeetingMediaFetchSchema,
        payload ?? {},
        "Invalid payload for meeting_media_fetch",
      );
      const { stream } = await openGuardedDownload(
        url,
        100 * 1024 * 1024,
        110_000,
      );
      const asset = await meetingMediaService.saveUpload(name, stream);
      return { success: true, data: asset };
    }

    case "meeting_media_list": {
      return { success: true, data: await meetingMediaService.listAssets() };
    }

    case "meeting_media_get": {
      const { asset_id } = parseRelayPayload(
        MeetingMediaGetSchema,
        payload ?? {},
        "Invalid payload for meeting_media_get",
      );
      return { success: true, data: await meetingMediaService.getAsset(asset_id) };
    }

    case "meeting_media_rendering_status": {
      return {
        success: true,
        data: await meetingMediaService.renderingStatus(),
      };
    }

    // Bridge-internal content layers on the meeting BACK graphics plane.
    // The handler only accepts structured inputs (asset id / vetted URL);
    // the HTML is bridge-authored in meeting-content-layers.ts.
    case "meeting_content_video_set": {
      const data = parseRelayPayload(
        MeetingContentVideoSetSchema,
        payload ?? {},
        "Invalid payload for meeting_content_video_set",
      );
      if (data.asset_id === null) {
        await meetingBackGraphicsManager.removeLayer({
          layerId: MEETING_CONTENT_VIDEO_LAYER_ID,
        });
        return { success: true, data: { active: false } };
      }
      const asset = await meetingMediaService.getAsset(data.asset_id);
      const mime = videoMimeForFilename(asset.filename);
      if (asset.sourceFormat !== "video" || !mime) {
        return { success: false, error: "Asset is not a video file." };
      }
      if (asset.renderStatus !== "ready") {
        return { success: false, error: "Video asset is not ready yet." };
      }
      const { serverPort } = getBridgeContext();
      if (!serverPort) {
        return { success: false, error: "Bridge server port is unavailable." };
      }
      const videoUrl = `http://127.0.0.1:${serverPort}/meeting/media/assets/${asset.assetId}/video`;
      const html = buildVideoLayerHtml(
        videoUrl,
        {
          mode: data.mode,
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
          rotation: data.rotation,
          rotationX: data.rotation_x,
          rotationY: data.rotation_y,
        },
        { muted: data.muted, loop: data.loop },
      );
      await meetingBackGraphicsManager.sendInternalLayer({
        layerId: MEETING_CONTENT_VIDEO_LAYER_ID,
        category: "slides",
        html,
        zIndex: 10,
      });
      return { success: true, data: { active: true, assetId: asset.assetId } };
    }

    case "meeting_browser_source_set": {
      const data = parseRelayPayload(
        MeetingBrowserSourceSetSchema,
        payload ?? {},
        "Invalid payload for meeting_browser_source_set",
      );
      if (data.url === null) {
        await meetingBackGraphicsManager.removeLayer({
          layerId: MEETING_BROWSER_SOURCE_LAYER_ID,
        });
        return { success: true, data: { active: false } };
      }
      let validatedUrl: string;
      try {
        validatedUrl = validateBrowserSourceUrl(data.url);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const html = buildBrowserSourceLayerHtml(validatedUrl, {
        mode: data.mode,
        x: data.x,
        y: data.y,
        width: data.width,
        height: data.height,
        rotation: data.rotation,
        rotationX: data.rotation_x,
        rotationY: data.rotation_y,
      });
      await meetingBackGraphicsManager.sendInternalLayer({
        layerId: MEETING_BROWSER_SOURCE_LAYER_ID,
        category: "slides",
        html,
        zIndex: 11,
      });
      return { success: true, data: { active: true, url: validatedUrl } };
    }

    case "meeting_call_control": {
      const { platform, action } = parseRelayPayload(
        MeetingCallControlSchema,
        payload ?? {},
        "Invalid payload for meeting_call_control",
      );
      try {
        // Independent of the meeting engine: controls the external client.
        return { success: true, data: await executeMeetingCallControl(platform, action) };
      } catch (error: unknown) {
        if (error instanceof MeetingCallControlError) {
          return { success: false, error: error.message, errorCode: error.code };
        }
        throw error;
      }
    }

    case "conference_display_start": {
      const target = parseRelayPayload(
        ConferenceDisplayStartSchema,
        payload ?? {},
        "Invalid payload for conference_display_start",
      );
      try {
        // The display window reads the meeting FrameBus, which the helper
        // only writes while its FrameBus output is running. The virtual-camera
        // path no longer starts it, so this is the consumer that must.
        await requireClient().framebusStart();
        await conferenceDisplayOutput.start({
          matchName: target.match_name,
          matchWidth: target.match_width,
          matchHeight: target.match_height,
        });
        return { success: true, data: conferenceDisplayOutput.status() };
      } catch (error: unknown) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Conference display failed to start",
          data: conferenceDisplayOutput.status(),
        };
      }
    }

    case "conference_display_stop": {
      await conferenceDisplayOutput.stop();
      // Release the helper's FrameBus output again; a helper that is already
      // gone has nothing left to stop.
      if (meetingHelperManager.isRunning()) {
        try {
          await requireClient().framebusStop();
        } catch (error: unknown) {
          console.warn(
            `[meeting] framebus stop after conference display stop failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return { success: true, data: conferenceDisplayOutput.status() };
    }

    case "conference_display_status": {
      return { success: true, data: conferenceDisplayOutput.status() };
    }

    case "conference_director_configure": {
      const patch = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for conference_director_configure",
      );
      const config = conferenceDirectorService.configure(
        parseDirectorConfigPatch(patch),
      );
      return {
        success: true,
        data: { config, status: conferenceDirectorService.status() },
      };
    }

    case "conference_director_start": {
      const patch = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for conference_director_start",
      );
      if (Object.keys(patch).length > 0) {
        conferenceDirectorService.configure(parseDirectorConfigPatch(patch));
      }
      // The webapp passes the live program camera; fall back to the wide shot
      // (or camera 0) so the first decision compares against a sensible shot.
      const initialCamera =
        typeof patch.initial_camera === "number"
          ? patch.initial_camera
          : (conferenceDirectorService.status().wide_camera_index as
              | number
              | null) ?? 0;
      try {
        await conferenceDirectorService.start(initialCamera);
        return { success: true, data: conferenceDirectorService.status() };
      } catch (error: unknown) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Conference director failed to start",
          data: conferenceDirectorService.status(),
        };
      }
    }

    case "conference_director_stop": {
      await conferenceDirectorService.stop();
      return { success: true, data: conferenceDirectorService.status() };
    }

    case "conference_director_status": {
      return { success: true, data: conferenceDirectorService.status() };
    }

    case "conference_director_inject": {
      const raw = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for conference_director_inject",
      );
      conferenceDirectorService.inject(parseInjectReading(raw));
      return { success: true, data: conferenceDirectorService.status() };
    }

    case "meeting_keyer_get": {
      return { success: true, data: await requireClient().keyerGet() };
    }

    case "meeting_keyer_configure": {
      const patch = parseRelayPayload(
        MeetingKeyerConfigureSchema,
        payload ?? {},
        "Invalid payload for meeting_keyer_configure",
      );
      const data = await requireClient().keyerConfigure(patch);
      meetingHelperManager.noteKeyerConfigured(patch);
      return { success: true, data };
    }

    case "meeting_keyer_reset": {
      return { success: true, data: await requireClient().keyerReset() };
    }

    case "meeting_program_get": {
      const { section } = parseRelayPayload(
        MeetingProgramUpdateSchema.pick({ section: true }),
        payload ?? {},
        "Invalid payload for meeting_program_get",
      );
      return { success: true, data: await requireClient().programGet(section) };
    }

    case "meeting_program_update": {
      const { section, values } = parseRelayPayload(
        MeetingProgramUpdateSchema,
        payload ?? {},
        "Invalid payload for meeting_program_update",
      );
      return {
        success: true,
        data: await requireClient().programUpdate(section, values),
      };
    }

    case "meeting_output_configure": {
      const { target, action, settings } = parseRelayPayload(
        MeetingOutputConfigureSchema,
        payload ?? {},
        "Invalid payload for meeting_output_configure",
      );
      const client = requireClient();
      if (target === "framebus") {
        if (action === "start") {
          return { success: true, data: await client.framebusStart() };
        }
        if (action === "stop") {
          return { success: true, data: await client.framebusStop() };
        }
        return {
          success: true,
          data: await client.framebusConfigure(settings ?? {}),
        };
      }
      if (action === "start") {
        // The only meeting RPC that previously bypassed runMeetingRpc: raw
        // COM HRESULT strings reached the UI as unhandled command errors.
        const result = await runMeetingRpc(() => client.virtualCameraStart());
        if (!result.success && result.error) {
          const mapped = mapVcamStartError(result.error);
          return { ...result, error: mapped.error, errorCode: mapped.errorCode };
        }
        meetingHelperManager.noteVirtualCameraStarted();
        return result;
      }
      if (action === "stop") {
        const result = await runMeetingRpc(() => client.virtualCameraStop());
        if (result.success) {
          meetingHelperManager.noteVirtualCameraStopped();
        }
        return result;
      }
      return runMeetingRpc(() => client.virtualCameraConfigure(settings ?? {}));
    }

    case "meeting_graphics_configure_outputs": {
      const {
        width = 1280,
        height = 720,
        fps = 30,
      } = parseRelayPayload(
        MeetingGraphicsConfigureOutputsSchema,
        payload ?? {},
        "Invalid payload for meeting_graphics_configure_outputs",
      );
      const outputsConfiguration = configureMeetingGraphicsOutputs(width, height, fps);
      if (outputsConfiguration.alreadySatisfiedOrPending) {
        // The pre-warm (or an earlier identical call) is already doing the
        // work; report success now instead of risking the relay timeout
        // behind a renderer cold start. Failures surface in the bridge log.
        outputsConfiguration.completion.catch((error: unknown) => {
          console.warn(
            `[meeting] graphics outputs configuration failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else {
        await outputsConfiguration.completion;
      }
      return {
        success: true,
        data: {
          framebusName: MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME,
          framebusNames: {
            back: MEETING_GRAPHICS_BACK_FRAMEBUS_NAME,
            front: MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME,
          },
          width,
          height,
          fps,
        },
      };
    }

    default:
      return {
        success: false,
        error: `Unknown meeting command: ${command}`,
      };
  }
}
