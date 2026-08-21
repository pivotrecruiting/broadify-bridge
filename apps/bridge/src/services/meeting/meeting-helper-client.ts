import net from "node:net";

import {
  DEFAULT_MEETING_FRAMEBUS_NAME,
  getVcamHelperStatus,
  openVcamHelperApp,
} from "../../modules/vcam/vcam-helper.js";
import { MEETING_HELPER_RPC_TIMEOUTS_MS } from "./meeting-helper-timeouts.js";
import { runVcamStartWithRegistrationSelfHeal } from "./vcam-registration-self-heal.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const FRAMEBUS_NAME_ENV = "BRIDGE_MEETING_FRAMEBUS_NAME";
/**
 * Stable error code for "the control socket/pipe could not be connected at
 * all" (ENOENT, ECONNREFUSED, ...). Distinct from `timeout` (connected, no
 * answer) and `connection_closed` (connected, closed before the response) so
 * the manager can treat it as a liveness signal.
 */
export const HELPER_NOT_REACHABLE_CODE = "helper_not_reachable";
const CONNECT_RETRY_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_BASE_DELAY_MS = 20;
/**
 * Connect-phase errors worth retrying on Windows. The helper recreates its
 * named-pipe instance between connections; libuv maps ERROR_FILE_NOT_FOUND in
 * that gap to ENOENT without retrying (it only retries ERROR_PIPE_BUSY).
 */
const WIN32_RETRYABLE_CONNECT_CODES = new Set(["ENOENT", "EPIPE", "ECONNREFUSED"]);

export type MeetingProgramSectionT =
  | "camera"
  | "cornerbug"
  | "graphics"
  | "speaker_layout"
  | "media_layer";

type JsonRpcResponseT<T> =
  | {
      id: string;
      ok: true;
      result: T;
    }
  | {
      id: string;
      ok: false;
      error?: {
        code?: string;
        message?: string;
      };
    };

export class MeetingHelperRequestError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = "MeetingHelperRequestError";
    this.code = code;
  }
}

/** Socket error raised before the request was written (nothing was sent). */
class ConnectPhaseError extends Error {
  readonly systemCode: string;

  constructor(systemCode: string, detail: string) {
    super(detail);
    this.name = "ConnectPhaseError";
    this.systemCode = systemCode;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type MeetingHelperClientOptionsT = {
  /** Platform used for the connect-retry policy (defaults to process.platform). */
  platform?: NodeJS.Platform;
};

/**
 * JSON-RPC client for the native meeting-helper control socket.
 */
export class MeetingHelperClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly retryConnectErrors: boolean;
  private requestSeq = 0;
  private rpcQueue: Promise<unknown> = Promise.resolve();

  constructor(
    socketPath: string,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    options: MeetingHelperClientOptionsT = {},
  ) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.retryConnectErrors = (options.platform ?? process.platform) === "win32";
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

  /**
   * Serialize every RPC through a queue. The Windows control channel is a
   * named pipe served by a single-threaded helper loop that recreates its
   * instance between connections; concurrent connections used to fail with
   * ENOENT (e.g. getFullStatus firing getState + framebusStatus in parallel,
   * or the web app sending commands at once). The helper now keeps a spare
   * instance parked, but RPCs are millisecond-scale, so serializing them is
   * negligible on all platforms and eliminates every present and future
   * collision.
   */
  private rpc<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    // Slow-by-design RPCs (permission prompts, MP4 finalization, model load)
    // get their own budget; everything else keeps the constructor default.
    const timeoutMs = MEETING_HELPER_RPC_TIMEOUTS_MS[method] ?? this.timeoutMs;
    const result = this.rpcQueue.then(
      () => this.rpcInternal<T>(method, params, timeoutMs),
      () => this.rpcInternal<T>(method, params, timeoutMs),
    );
    // Chain the next RPC after this one settles; swallow errors here so one
    // failed RPC never rejects the shared queue for later callers.
    this.rpcQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * One RPC with a bounded connect-phase retry. Only failures raised BEFORE the
   * request was written are retried (and only on Windows, see
   * WIN32_RETRYABLE_CONNECT_CODES): RPCs are not idempotent, so anything after
   * the write surfaces as-is. Every connect-level failure ends up as
   * MeetingHelperRequestError(helper_not_reachable) carrying the system code
   * so command responses get a stable errorCode instead of a raw ENOENT.
   */
  private async rpcInternal<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const id = `req-${++this.requestSeq}`;
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + "\n";
    const deadline = Date.now() + timeoutMs;

    for (let attempt = 1; ; attempt += 1) {
      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        return await this.rpcAttempt<T>(id, payload, remainingMs);
      } catch (error: unknown) {
        if (!(error instanceof ConnectPhaseError)) {
          throw error;
        }
        const delayMs = CONNECT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        const retryable =
          this.retryConnectErrors &&
          WIN32_RETRYABLE_CONNECT_CODES.has(error.systemCode) &&
          attempt < CONNECT_RETRY_MAX_ATTEMPTS &&
          Date.now() + delayMs < deadline;
        if (!retryable) {
          throw new MeetingHelperRequestError(
            HELPER_NOT_REACHABLE_CODE,
            `Meeting helper control socket not reachable (${error.systemCode}) for ${method} after ${attempt} attempt(s): ${error.message}`,
          );
        }
        await sleep(delayMs);
      }
    }
  }

  private rpcAttempt<T>(id: string, payload: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      let requestWritten = false;

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(error);
      };

      const timeout = setTimeout(() => {
        settleReject(
          new MeetingHelperRequestError(
            "timeout",
            `Meeting helper request timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      socket.on("connect", () => {
        requestWritten = true;
        socket.write(payload);
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffer.slice(0, newlineIndex);
        try {
          const parsed = JSON.parse(line) as JsonRpcResponseT<T>;
          if (parsed.id !== id) {
            throw new MeetingHelperRequestError(
              "id_mismatch",
              "Meeting helper returned a response for a different request.",
            );
          }
          if (!parsed.ok) {
            throw new MeetingHelperRequestError(
              parsed.error?.code || "request_failed",
              parsed.error?.message || "Meeting helper request failed.",
            );
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
            resolve(parsed.result);
          }
        } catch (error: unknown) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (!requestWritten) {
          settleReject(
            new ConnectPhaseError(error.code ?? "UNKNOWN", error.message),
          );
          return;
        }
        settleReject(error);
      });

      socket.on("close", () => {
        if (!settled) {
          settleReject(
            new MeetingHelperRequestError(
              "connection_closed",
              "Meeting helper control socket closed before a response was received.",
            ),
          );
        }
      });
    });
  }
}
