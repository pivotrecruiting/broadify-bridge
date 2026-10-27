/**
 * Web app open gate.
 *
 * After a bridge start the browser must not be opened right away: the
 * `bridgeStart` IPC result resolves as soon as the bridge process is spawned,
 * which is before the HTTP server listens and before the relay authentication
 * finished. Opening the web app at that point makes its first bridge lookup
 * fail (only a browser refresh recovers) and the tab opens while the desktop
 * window is still activating, so it does not come to the front.
 *
 * The gate is armed with the URL to open and fed with health-check statuses.
 * It opens the URL exactly once on the first status that reports
 * `running && reachable && relayConnected`. If that never happens within
 * `timeoutMs` (no internet, relay unreachable) it opens anyway so the user
 * still gets to the web app, which then shows the bridge state itself.
 *
 * Pure module: no Electron import, timers are injectable for tests.
 */

/** Default time to wait for relay authentication before opening anyway. */
export const WEB_APP_OPEN_RELAY_TIMEOUT_MS = 15_000;

/** Subset of the bridge status the gate decides on. */
export type WebAppOpenGateStatusT = {
  running: boolean;
  reachable: boolean;
  relayConnected?: boolean;
};

export type WebAppOpenGateLoggerT = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type WebAppOpenGateOptionsT = {
  /** Opens the URL (e.g. `shell.openExternal`). Rejections are logged, never thrown. */
  open: (url: string) => void | Promise<unknown>;
  /** Fallback delay; defaults to `WEB_APP_OPEN_RELAY_TIMEOUT_MS`. */
  timeoutMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  logger?: WebAppOpenGateLoggerT;
};

export type WebAppOpenGateT = {
  /** Arm the gate with the URL to open; replaces a pending URL and restarts the fallback timer. */
  arm: (url: string) => void;
  /** Feed a health-check status; opens on the first ready status while armed. */
  onStatus: (status: WebAppOpenGateStatusT) => void;
  /** Cancel a pending open without opening (bridge stopped/failed, app shutdown). Idempotent. */
  disarm: () => void;
  /** Whether an open is still pending. */
  isArmed: () => boolean;
};

const NOOP_LOGGER: WebAppOpenGateLoggerT = {
  info: () => {},
  warn: () => {},
};

/**
 * Create a web app open gate.
 *
 * @param options Opener, fallback timeout, injectable timers and logger.
 * @returns Gate with `arm`, `onStatus`, `disarm`, `isArmed`.
 */
export function createWebAppOpenGate(
  options: WebAppOpenGateOptionsT,
): WebAppOpenGateT {
  const timeoutMs = options.timeoutMs ?? WEB_APP_OPEN_RELAY_TIMEOUT_MS;
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const logger = options.logger ?? NOOP_LOGGER;

  let pendingUrl: string | null = null;
  let timerHandle: unknown = null;

  const clearTimer = () => {
    if (timerHandle !== null) {
      clearTimeoutFn(timerHandle);
      timerHandle = null;
    }
  };

  const openNow = (reason: string) => {
    const url = pendingUrl;
    pendingUrl = null;
    clearTimer();
    if (!url) {
      return;
    }
    logger.info(`[WebApp] Opening web app (${reason})`);
    try {
      const result = options.open(url);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(`[WebApp] Failed to open web app: ${message}`);
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[WebApp] Failed to open web app: ${message}`);
    }
  };

  const arm = (url: string) => {
    clearTimer();
    pendingUrl = url;
    timerHandle = setTimeoutFn(() => {
      timerHandle = null;
      logger.warn(
        `[WebApp] Relay not connected within ${timeoutMs}ms; opening web app anyway`,
      );
      openNow("relay timeout");
    }, timeoutMs);
  };

  const onStatus = (status: WebAppOpenGateStatusT) => {
    if (pendingUrl === null) {
      return;
    }
    if (status.running && status.reachable && status.relayConnected === true) {
      openNow("bridge reachable and relay connected");
    }
  };

  const disarm = () => {
    if (pendingUrl !== null) {
      logger.info("[WebApp] Pending web app open cancelled");
    }
    pendingUrl = null;
    clearTimer();
  };

  return {
    arm,
    onStatus,
    disarm,
    isArmed: () => pendingUrl !== null,
  };
}
