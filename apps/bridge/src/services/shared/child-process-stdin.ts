import type { ChildProcess } from "node:child_process";

export type StdinLoggerT = {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
};

/**
 * Error codes that only mean "the helper already closed its end of the pipe".
 * They are expected during shutdown races and must never surface as failures.
 */
export const BENIGN_STDIN_ERROR_CODES = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/** Streams that already carry our `error` listener; prevents duplicate handlers. */
const HANDLED_STDIN_STREAMS = new WeakSet<NodeJS.WritableStream>();

const describeError = (error: unknown): { code: string | undefined; message: string } => {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    return {
      code: typeof code === "string" ? code : undefined,
      message: typeof message === "string" ? message : String(error),
    };
  }
  return { code: undefined, message: String(error) };
};

/**
 * Attaches an idempotent `error` handler to `child.stdin`.
 *
 * Without a listener, an asynchronous stdin error (typically `EPIPE` after the
 * helper exited) is raised as `uncaughtException` and takes the whole bridge
 * down. Benign codes (`EPIPE`, `ERR_STREAM_DESTROYED`,
 * `ERR_STREAM_WRITE_AFTER_END`) are logged at debug because the helper is
 * already gone; anything else is logged at warn. Never throws.
 *
 * @param child Spawned helper process.
 * @param label Log prefix identifying the helper.
 * @param logger Logger receiving the debug/warn lines.
 */
export function attachChildStdinErrorHandler(
  child: ChildProcess,
  label: string,
  logger: StdinLoggerT,
): void {
  try {
    const stdin = child.stdin;
    if (!stdin || typeof stdin.on !== "function") {
      return;
    }
    if (HANDLED_STDIN_STREAMS.has(stdin)) {
      return;
    }
    HANDLED_STDIN_STREAMS.add(stdin);
    stdin.on("error", (error: unknown) => {
      const { code, message } = describeError(error);
      const line = `[${label}] stdin error${code ? ` (${code})` : ""}: ${message}`;
      if (code && BENIGN_STDIN_ERROR_CODES.has(code)) {
        logger.debug?.(`${line} (helper already gone)`);
        return;
      }
      logger.warn(line);
    });
  } catch {
    // Attaching a listener must never break the caller's lifecycle handling.
  }
}

/**
 * Writes `chunk` to `child.stdin` when the stream is writable.
 *
 * @param child Spawned helper process.
 * @param chunk Payload to write.
 * @param label Log prefix identifying the helper.
 * @param logger Logger receiving the debug line when the write is dropped.
 * @returns `true` when the write was handed to the stream, `false` when stdin
 *   is missing, not writable, or `write` threw synchronously.
 */
export function writeChildStdin(
  child: ChildProcess,
  chunk: string | Buffer,
  label: string,
  logger: StdinLoggerT,
): boolean {
  const stdin = child.stdin;
  if (!stdin || !stdin.writable) {
    logger.debug?.(`[${label}] stdin not writable; dropping write`);
    return false;
  }
  try {
    stdin.write(chunk);
    return true;
  } catch (error) {
    const { code, message } = describeError(error);
    logger.debug?.(
      `[${label}] stdin write failed${code ? ` (${code})` : ""}: ${message}`,
    );
    return false;
  }
}
