import {
  DEFAULT_MEETING_FRAMEBUS_NAME,
  getVcamHelperStatus,
  openVcamHelperApp,
} from "../../modules/vcam/vcam-helper.js";
import { HelperRequestError, LineRpcClient } from "../helpers/helper-rpc-client.js";
import { MEETING_HELPER_RPC_TIMEOUTS_MS } from "./meeting-helper-timeouts.js";
import { runVcamStartWithRegistrationSelfHeal } from "./vcam-registration-self-heal.js";

const FRAMEBUS_NAME_ENV = "BRIDGE_MEETING_FRAMEBUS_NAME";
/**
 * Stable error code for "the control socket/pipe could not be connected at
 * all" (ENOENT, ECONNREFUSED, ...). Distinct from `timeout` (connected, no
 * answer) and `connection_closed` (connected, closed before the response) so
 * the manager can treat it as a liveness signal.
 */
export { HELPER_NOT_REACHABLE_CODE } from "../helpers/helper-rpc-client.js";

export type MeetingProgramSectionT =
  | "camera"
  | "cornerbug"
  | "graphics"
  | "speaker_layout"
  | "media_layer";

export class MeetingHelperRequestError extends HelperRequestError {
  constructor(code: string, detail: string) {
    super(code, detail);
    this.name = "MeetingHelperRequestError";
  }
}

export type MeetingHelperClientOptionsT = {
  /** Platform used for the connect-retry policy (defaults to process.platform). */
  platform?: NodeJS.Platform;
};

/**
 * JSON-RPC client for the native meeting-helper control socket. Transport
 * (queue, connect retry, timeouts) lives in helpers/helper-rpc-client.ts.
 */
export class MeetingHelperClient extends LineRpcClient {
  constructor(
    socketPath: string,
    timeoutMs: number = 5000,
    options: MeetingHelperClientOptionsT = {},
  ) {
    super(socketPath, {
      helperName: "Meeting helper",
      timeoutMs,
      // Slow-by-design RPCs (permission prompts, MP4 finalization, model load)
      // get their own budget; everything else keeps the constructor default.
      methodTimeoutsMs: MEETING_HELPER_RPC_TIMEOUTS_MS,
      platform: options.platform,
      createError: (code, detail) => new MeetingHelperRequestError(code, detail),
    });
  }

  async ping(): Promise<boolean> {
    try {
      return await this.pingOrThrow();
    } catch {
      return false;
    }
  }

  /** Like ping(), but surfaces the failure so start-up can log its cause. */
  async pingOrThrow(): Promise<boolean> {
    const result = await this.rpc<{ pong?: boolean }>("control.ping");
    return result.pong === true;
  }

  async shutdown(): Promise<Record<string, unknown>> {
    return this.rpc("control.shutdown");
  }

  async getState(): Promise<Record<string, unknown>> {
    return this.rpc("state.get");
  }

  async getPipelineState(): Promise<Record<string, unknown>> {
    return this.getState();
  }

  async getPerformance(): Promise<Record<string, unknown>> {
    return { available: true, source: "meeting-helper" };
  }

  async listCameras(): Promise<unknown> {
    return this.rpc("camera.list");
  }

  async requestCameraPermission(): Promise<Record<string, unknown>> {
    return this.rpc("camera.permission.request");
  }

  async cameraStart(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("camera.start", options);
  }

  async cameraStop(): Promise<Record<string, unknown>> {
    return this.rpc("camera.stop");
  }

  async cameraReopen(): Promise<Record<string, unknown>> {
    return this.rpc("camera.reopen");
  }

  async recordingMicrophones(): Promise<Record<string, unknown>> {
    return this.rpc("recording.microphones");
  }

  async recordingStart(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("recording.start", options);
  }

  async recordingStop(): Promise<Record<string, unknown>> {
    return this.rpc("recording.stop");
  }

  async recordingStatus(): Promise<Record<string, unknown>> {
    return this.rpc("recording.status");
  }

  async cameraSelect(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("camera.select", options);
  }

  /** Conference: open several cameras at once for seamless switching. */
  async cameraOpenSet(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("camera.open_set", options);
  }

  /** Conference: cut the program feed to an already-open camera. */
  async cameraProgramSelect(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("camera.program_select", options);
  }

  /** Conference: draw an open camera as picture-in-picture (-1 = off). */
  async cameraPipSet(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("camera.pip_set", options);
  }

  /** Conference: per-camera microphone level (0..1) of the open cameras. */
  async cameraAudioLevels(): Promise<Record<string, unknown>> {
    return this.rpc("camera.audio_levels", {});
  }

  /** Conference auto-director: follow the loudest camera automatically. */
  async cameraAutoDirector(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("camera.auto_director", options);
  }

  async screenList(): Promise<Record<string, unknown>> {
    return this.rpc("screen.list");
  }

  async screenStart(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("screen.start", options);
  }

  async screenStop(): Promise<Record<string, unknown>> {
    return this.rpc("screen.stop");
  }

  async screenPick(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("screen.pick", options);
  }

  async keyerGet(): Promise<Record<string, unknown>> {
    return this.rpc("keyer.get");
  }

  async keyerConfigure(
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("keyer.configure", patch);
  }

  async keyerReset(): Promise<Record<string, unknown>> {
    return this.rpc("keyer.reset");
  }

  async programGet(
    section: MeetingProgramSectionT,
  ): Promise<Record<string, unknown>> {
    return this.rpc("program.get", { section });
  }

  async programUpdate(
    section: MeetingProgramSectionT,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("program.update", { section, values });
  }

  async framebusStatus(): Promise<Record<string, unknown>> {
    return this.rpc("output.framebus.status");
  }

  async framebusConfigure(
    settings: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.rpc("output.framebus.configure", settings);
  }

  async framebusStart(): Promise<Record<string, unknown>> {
    return this.rpc("output.framebus.start");
  }

  async framebusStop(): Promise<Record<string, unknown>> {
    return this.rpc("output.framebus.stop");
  }

  async virtualCameraStatus(): Promise<Record<string, unknown>> {
    if (process.platform === "win32") {
      // Windows: the virtual camera is owned by the native meeting-helper
      // (MFCreateVirtualCamera), not a separate app.
      return this.rpc("output.vcam.status");
    }
    return getVcamHelperStatus({
      framebusName: process.env[FRAMEBUS_NAME_ENV] || DEFAULT_MEETING_FRAMEBUS_NAME,
    });
  }

  async virtualCameraConfigure(
    settings: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return {
      ...(await this.virtualCameraStatus()),
      requested_settings: settings,
    };
  }

  /**
   * Arm the virtual camera without touching the FrameBus output. The FrameBus
   * (shared memory) is only read by the conference display output; both
   * virtual-camera consumers (macOS extension, Windows media-source DLL) pull
   * frames over the raw-frame TCP stream and connect lazily while an app is
   * actually streaming. Starting the FrameBus here used to copy every program
   * frame (~250 MB/s at 1080p) into a segment nobody read. `framebus_output`
   * stays in the result for the web app's engagement check, but as a
   * read-only status snapshot.
   *
   * `allowElevation` (default true) lets the Windows registration self-heal
   * raise a UAC prompt; the unattended engine-start auto-arm passes false so
   * no prompt ever appears without an explicit operator action.
   */
  async virtualCameraStart(
    options: { allowElevation?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const framebusOutput = await this.framebusStatus();
    await this.vcamRawStart();
    if (process.platform === "win32") {
      // Windows has no separate helper app: ask the meeting-helper to create
      // the "Broadify Camera" (MFCreateVirtualCamera). A REGDB_E_CLASSNOTREG
      // failure triggers a one-shot elevated regsvr32 self-heal (MSI
      // registration gap) before giving up - unless elevation is disallowed.
      let vcam: Record<string, unknown>;
      try {
        vcam = await runVcamStartWithRegistrationSelfHeal(
          () => this.rpc("output.vcam.start"),
          { allowElevation: options.allowElevation ?? true },
        );
      } catch (error) {
        // Roll the partial output state back: a failed vcam start must not
        // leave the raw frame stream armed.
        try {
          await this.vcamRawStop();
        } catch {
          // Best effort; the original vcam error is the one that matters.
        }
        throw error;
      }
      return { ...vcam, framebus_output: framebusOutput };
    }
    const status = await openVcamHelperApp({
      framebusName: process.env[FRAMEBUS_NAME_ENV] || DEFAULT_MEETING_FRAMEBUS_NAME,
    });
    return {
      ...status,
      framebus_output: framebusOutput,
    };
  }

  /**
   * Disarm the virtual camera. Only the raw-frame stream is stopped; a
   * FrameBus output started by another consumer (conference display, explicit
   * `meeting_output_configure`) keeps running.
   */
  async virtualCameraStop(): Promise<Record<string, unknown>> {
    await this.vcamRawStop();
    const framebusOutput = await this.framebusStatus();
    if (process.platform === "win32") {
      const vcam = await this.rpc("output.vcam.stop");
      return {
        ...vcam,
        framebus_output: framebusOutput,
        message:
          "Virtual camera output was stopped. Meeting preview and program rendering remain active.",
      };
    }
    return {
      ...(await this.virtualCameraStatus()),
      framebus_output: framebusOutput,
      message:
        "Virtual camera output was stopped. Meeting preview and program rendering remain active.",
    };
  }

  /** Enable the raw-frame TCP stream the virtual-camera consumers read. */
  private async vcamRawStart(): Promise<Record<string, unknown>> {
    return this.rpc("output.vcam.raw.start");
  }

  /** Disable the raw-frame TCP stream; connected consumers see a black feed. */
  private async vcamRawStop(): Promise<Record<string, unknown>> {
    return this.rpc("output.vcam.raw.stop");
  }
}
