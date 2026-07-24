import net from "node:net";

import {
  DEFAULT_MEETING_FRAMEBUS_NAME,
  getVcamHelperStatus,
  openVcamHelperApp,
} from "../../modules/vcam/vcam-helper.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const FRAMEBUS_NAME_ENV = "BRIDGE_MEETING_FRAMEBUS_NAME";

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

/**
 * JSON-RPC client for the native meeting-helper control socket.
 */
export class MeetingHelperClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private requestSeq = 0;
  private rpcQueue: Promise<unknown> = Promise.resolve();

  constructor(socketPath: string, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.rpc<{ pong?: boolean }>("control.ping");
      return result.pong === true;
    } catch {
      return false;
    }
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

  async virtualCameraStart(): Promise<Record<string, unknown>> {
    if (process.platform === "win32") {
      // Windows has no separate helper app: start the raw frame output and ask
      // the meeting-helper to create the "Broadify Camera" (MFCreateVirtualCamera).
      const framebusOutput = await this.framebusStart();
      const vcam = await this.rpc("output.vcam.start");
      return { ...vcam, framebus_output: framebusOutput };
    }
    const framebusOutput = await this.framebusStart();
    const status = await openVcamHelperApp({
      framebusName: process.env[FRAMEBUS_NAME_ENV] || DEFAULT_MEETING_FRAMEBUS_NAME,
    });
    return {
      ...status,
      framebus_output: framebusOutput,
    };
  }

  async virtualCameraStop(): Promise<Record<string, unknown>> {
    if (process.platform === "win32") {
      const framebusOutput = await this.framebusStop();
      const vcam = await this.rpc("output.vcam.stop");
      return {
        ...vcam,
        framebus_output: framebusOutput,
        message:
          "Virtual camera output was stopped. Meeting preview and program rendering remain active.",
      };
    }
    const framebusOutput = await this.framebusStop();
    return {
      ...(await this.virtualCameraStatus()),
      framebus_output: framebusOutput,
      message:
        "Virtual camera output was stopped. Meeting preview and program rendering remain active.",
    };
  }

  /**
   * Serialize every RPC through a queue. The Windows control channel is a
   * single-instance named pipe that accepts exactly one connection at a time;
   * concurrent connections fail with ENOENT (e.g. getFullStatus firing
   * getState + framebusStatus in parallel, or the web app sending commands at
   * once). RPCs are millisecond-scale, so serializing them is negligible on all
   * platforms and eliminates every present and future collision.
   */
  private rpc<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const result = this.rpcQueue.then(
      () => this.rpcInternal<T>(method, params),
      () => this.rpcInternal<T>(method, params),
    );
    // Chain the next RPC after this one settles; swallow errors here so one
    // failed RPC never rejects the shared queue for later callers.
    this.rpcQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private rpcInternal<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = `req-${++this.requestSeq}`;
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;

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
            `Meeting helper request timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      socket.on("connect", () => {
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

      socket.on("error", (error) => {
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
