import {
  parseRelayPayload,
  EmptyPayloadSchema,
} from "../relay-command-schemas.js";
import {
  MeetingButtonModeSchema,
  MeetingButtonTriggerSchema,
  MeetingEngineStartSchema,
  MeetingGraphicsConfigureOutputsSchema,
  MeetingKeyerConfigureSchema,
  MeetingOutputConfigureSchema,
  MeetingPassthroughSchema,
  MeetingProgramUpdateSchema,
} from "./meeting-command-schemas.js";
import { meetingHelperManager } from "./meeting-helper-manager.js";
import type { MeetingHelperClient } from "./meeting-helper-client.js";
import { meetingGraphicsManager } from "./meeting-graphics-manager.js";
import { loadFrameBusModule } from "../graphics/framebus/framebus-client.js";

export type MeetingCommandResultT = {
  success: boolean;
  data?: unknown;
  error?: string;
};

const ENGINE_NOT_RUNNING_ERROR =
  "Meeting engine is not running. Start it with meeting_engine_start first.";
const MEETING_GRAPHICS_FRAMEBUS_NAME = "bfy-meet-gfx";
const DEFAULT_MEETING_GRAPHICS_FORMAT = { width: 1280, height: 720, fps: 30 };
const MEETING_GRAPHICS_SLOT_COUNT = 3;
const MEETING_GRAPHICS_PIXEL_FORMAT = 1;

function requireClient(): MeetingHelperClient {
  const client = meetingHelperManager.getClient();
  if (!client || !meetingHelperManager.isRunning()) {
    throw new Error(ENGINE_NOT_RUNNING_ERROR);
  }
  return client;
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
    const writer = module.createWriter({
      name: MEETING_GRAPHICS_FRAMEBUS_NAME,
      width,
      height,
      fps,
      pixelFormat: MEETING_GRAPHICS_PIXEL_FORMAT,
      slotCount: MEETING_GRAPHICS_SLOT_COUNT,
      forceRecreate: true,
    });
    writer.writeFrame(Buffer.alloc(width * height * 4, 0));
    writer.close();
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
  return command.startsWith("meeting_");
}

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
      const status = await meetingHelperManager.start(options);
      if (status.state !== "running") {
        return {
          success: false,
          error: status.lastError || "Meeting engine failed to start",
          data: status,
        };
      }
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
      return { success: true, data: await requireClient().listCameras() };
    }

    case "meeting_camera_select": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_select",
      );
      return {
        success: true,
        data: await requireClient().cameraSelect(options),
      };
    }

    case "meeting_camera_start": {
      const options = parseRelayPayload(
        MeetingPassthroughSchema,
        payload ?? {},
        "Invalid payload for meeting_camera_start",
      );
      return {
        success: true,
        data: await requireClient().cameraStart(options),
      };
    }

    case "meeting_camera_stop": {
      return { success: true, data: await requireClient().cameraStop() };
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

    case "meeting_button_list": {
      const { mode } = parseRelayPayload(
        MeetingButtonModeSchema,
        payload ?? {},
        "Invalid payload for meeting_button_list",
      );
      return { success: true, data: await requireClient().buttonsList(mode) };
    }

    case "meeting_button_trigger": {
      const { mode, buttonId } = parseRelayPayload(
        MeetingButtonTriggerSchema,
        payload ?? {},
        "Invalid payload for meeting_button_trigger",
      );
      return {
        success: true,
        data: await requireClient().buttonTrigger(mode, buttonId),
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
      process.env.BRIDGE_FRAMEBUS_NAME = MEETING_GRAPHICS_FRAMEBUS_NAME;
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "3";
      process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "1";
      await meetingGraphicsManager.configureOutputs({
        outputKey: "framebus",
        targets: {},
        format: { width, height, fps },
        range: "full",
        colorspace: "rec709",
      });
      return {
        success: true,
        data: {
          framebusName: MEETING_GRAPHICS_FRAMEBUS_NAME,
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
