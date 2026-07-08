import {
  parseRelayPayload,
  EmptyPayloadSchema,
} from "../relay-command-schemas.js";
import {
  ConferenceDisplayStartSchema,
  MeetingCallControlSchema,
  MeetingEngineStartSchema,
  MeetingGraphicsConfigureOutputsSchema,
  MeetingKeyerConfigureSchema,
  MeetingOutputConfigureSchema,
  MeetingPassthroughSchema,
  MeetingProgramUpdateSchema,
} from "./meeting-command-schemas.js";
import { ConferenceDisplayOutput } from "../conference/conference-display-output.js";
import { meetingHelperManager } from "./meeting-helper-manager.js";
import {
  executeMeetingCallControl,
  MeetingCallControlError,
} from "./meeting-call-control.js";
import {
  MeetingHelperRequestError,
  type MeetingHelperClient,
} from "./meeting-helper-client.js";
import {
  MEETING_GRAPHICS_BACK_FRAMEBUS_NAME,
  MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME,
  meetingBackGraphicsManager,
  meetingFrontGraphicsManager,
} from "./meeting-graphics-manager.js";
import { loadFrameBusModule } from "../graphics/framebus/framebus-client.js";

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
const MEETING_GRAPHICS_SLOT_COUNT = 3;
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
    process.env.BRIDGE_FRAMEBUS_NAME = MEETING_GRAPHICS_BACK_FRAMEBUS_NAME;
    process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "3";
    process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "1";
    await meetingBackGraphicsManager.configureOutputs({
      outputKey: "framebus",
      targets: {},
      format: { width, height, fps },
      range: "full",
      colorspace: "rec709",
    });
    process.env.BRIDGE_FRAMEBUS_NAME = MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME;
    process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "3";
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
      clearMeetingGraphicsFrameBus(options, "engine_start");
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
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_select",
      );
      return runMeetingRpc(() => requireClient().cameraSelect(options));
    }

    case "meeting_camera_start": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_start",
      );
      return runMeetingRpc(() => requireClient().cameraStart(options));
    }

    case "meeting_camera_stop": {
      return runMeetingRpc(() => requireClient().cameraStop());
    }

    case "meeting_camera_open_set": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_open_set",
      );
      return runMeetingRpc(() => requireClient().cameraOpenSet(options));
    }

    case "meeting_camera_program_select": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_program_select",
      );
      return runMeetingRpc(() => requireClient().cameraProgramSelect(options));
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
      return { success: true, data: conferenceDisplayOutput.status() };
    }

    case "conference_display_status": {
      return { success: true, data: conferenceDisplayOutput.status() };
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
      return {
        success: true,
        data: await requireClient().keyerConfigure(patch),
      };
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
        return { success: true, data: await client.virtualCameraStart() };
      }
      if (action === "stop") {
        return { success: true, data: await client.virtualCameraStop() };
      }
      return {
        success: true,
        data: await client.virtualCameraConfigure(settings ?? {}),
      };
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
