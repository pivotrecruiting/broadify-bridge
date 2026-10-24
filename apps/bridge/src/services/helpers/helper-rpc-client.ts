import net from "node:net";

/**
 * Line-oriented JSON-RPC client for the native helpers' control socket
 * (Unix domain socket / Windows named pipe): one connection per request,
 * one JSON line each way. Shared by the meeting and PGM helper clients.
 *
 * Every RPC is serialized through a queue (the Windows pipe is served by a
 * single-threaded helper loop; RPCs are millisecond-scale). Connect-phase
 * failures are retried on Windows only (the helper recreates its pipe
 * instance between connections and libuv maps that gap to ENOENT).
 */
export const HELPER_NOT_REACHABLE_CODE = "helper_not_reachable";
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const CONNECT_RETRY_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_BASE_DELAY_MS = 20;
const WIN32_RETRYABLE_CONNECT_CODES = new Set(["ENOENT", "EPIPE", "ECONNREFUSED"]);

type JsonRpcResponseT<T> =
  | { id: string; ok: true; result: T }
  | { id: string; ok: false; error?: { code?: string; message?: string } };

/** Error with a stable code; helper clients subclass it to keep their own class identity. */
export class HelperRequestError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = "HelperRequestError";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type LineRpcClientOptionsT = {
  /** Human name used in error messages ("Meeting helper", "PGM helper"). */
  helperName: string;
  timeoutMs?: number;
  /** Per-method budgets for slow-by-design RPCs. */
  methodTimeoutsMs?: Record<string, number>;
  /** Platform used for the connect-retry policy (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Builds the error instance so subclasses keep their own error class. */
  createError?: (code: string, detail: string) => HelperRequestError;
};

export class LineRpcClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly methodTimeoutsMs: Record<string, number>;
  private readonly helperName: string;
  private readonly retryConnectErrors: boolean;
  private readonly createError: (code: string, detail: string) => HelperRequestError;
  private requestSeq = 0;
  private rpcQueue: Promise<unknown> = Promise.resolve();

  constructor(socketPath: string, options: LineRpcClientOptionsT) {
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.methodTimeoutsMs = options.methodTimeoutsMs ?? {};
    this.helperName = options.helperName;
    this.retryConnectErrors = (options.platform ?? process.platform) === "win32";
    this.createError = options.createError ?? ((code, detail) => new HelperRequestError(code, detail));
  }

  protected rpc<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    const timeoutMs = this.methodTimeoutsMs[method] ?? this.timeoutMs;
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

  private async rpcInternal<T>(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<T> {
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
          throw this.createError(
            HELPER_NOT_REACHABLE_CODE,
            `${this.helperName} control socket not reachable (${error.systemCode}) for ${method} after ${attempt} attempt(s): ${error.message}`,
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
        settleReject(this.createError("timeout", `${this.helperName} request timed out after ${timeoutMs}ms`));
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
            throw this.createError("id_mismatch", `${this.helperName} returned a response for a different request.`);
          }
          if (!parsed.ok) {
            throw this.createError(parsed.error?.code || "request_failed", parsed.error?.message || `${this.helperName} request failed.`);
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
          settleReject(new ConnectPhaseError(error.code ?? "UNKNOWN", error.message));
          return;
        }
        settleReject(error);
      });
      socket.on("close", () => {
        if (!settled) {
          settleReject(this.createError("connection_closed", `${this.helperName} control socket closed before a response was received.`));
        }
      });
    });
  }
}
