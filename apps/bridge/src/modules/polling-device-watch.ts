/**
 * Polling-based device watcher for modules without a native hotplug source.
 *
 * The watcher periodically runs the module's own `detect()` and compares a
 * stable fingerprint of the result with the previous one. Subscribers are only
 * notified when the fingerprint changes, so the device cache does not refresh
 * on every tick. Timers are injectable to keep the watcher testable.
 */

export type PollingDeviceWatchLoggerT = {
  warn: (message: string) => void;
  info?: (message: string) => void;
  debug?: (message: string) => void;
};

export type PollingDeviceWatchOptionsT<T> = {
  /** Detection function; usually the module's `detect()`. */
  detect: () => Promise<T[]>;
  /** Poll period in milliseconds. */
  intervalMs: number;
  /** Stable, order-independent string describing the device set. */
  fingerprint: (devices: T[]) => string;
  /** Log prefix, e.g. `DisplayModule`. */
  label?: string;
  logger: PollingDeviceWatchLoggerT;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export type PollingDeviceWatchT<T> = (
  callback: (devices: T[]) => void,
) => () => void;

const DEFAULT_LABEL = "PollingDeviceWatch";

/**
 * Create a watch function that polls `detect()` every `intervalMs`.
 *
 * Semantics:
 * - Subscribing starts an immediate baseline poll; the baseline is never
 *   emitted, so a device that is already connected does not trigger a refresh.
 * - Subsequent polls emit only when the fingerprint differs from the baseline
 *   or the last emitted state.
 * - A tick is skipped while a previous `detect()` is still in flight.
 * - Detect failures are logged at warn level once per failure series; polling
 *   continues and the last known fingerprint is kept.
 * - The interval timer is `unref()`ed so it never keeps the process alive.
 */
export const createPollingDeviceWatch = <T>(
  options: PollingDeviceWatchOptionsT<T>,
): PollingDeviceWatchT<T> => {
  const {
    detect,
    intervalMs,
    fingerprint,
    logger,
    label = DEFAULT_LABEL,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  return (callback) => {
    let stopped = false;
    let inFlight = false;
    let lastFingerprint: string | null = null;
    let failureSeriesActive = false;

    const poll = async (): Promise<void> => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const devices = await detect();
        if (stopped) {
          return;
        }
        if (failureSeriesActive) {
          failureSeriesActive = false;
          logger.info?.(`[${label}] Poll recovered after failure`);
        }
        const next = fingerprint(devices);
        if (lastFingerprint === null) {
          lastFingerprint = next;
          return;
        }
        if (next === lastFingerprint) {
          return;
        }
        lastFingerprint = next;
        callback(devices);
      } catch (error) {
        if (stopped) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!failureSeriesActive) {
          failureSeriesActive = true;
          logger.warn(
            `[${label}] Poll failed; keeping last known state until it recovers: ${message}`,
          );
        } else {
          logger.debug?.(`[${label}] Poll still failing: ${message}`);
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = setIntervalFn(() => {
      void poll();
    }, intervalMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }

    void poll();

    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearIntervalFn(timer);
    };
  };
};

export type ResolvePollingIntervalParamsT = {
  /** Environment variable name, used in the warning message only. */
  envName: string;
  envValue: string | undefined;
  defaultMs: number;
  /** Smallest accepted value; protects helpers from being hammered. */
  minMs: number;
  logger: Pick<PollingDeviceWatchLoggerT, "warn">;
};

/**
 * Resolve a poll interval from an environment override.
 *
 * Accepts only plain decimal integers at or above `minMs`; anything else
 * falls back to `defaultMs` with a warning. An unset or blank variable is not
 * an error.
 */
export const resolvePollingIntervalMs = (
  params: ResolvePollingIntervalParamsT,
): number => {
  const { envName, envValue, defaultMs, minMs, logger } = params;
  const raw = envValue?.trim() ?? "";
  if (raw === "") {
    return defaultMs;
  }
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minMs) {
    logger.warn(
      `[${DEFAULT_LABEL}] Ignoring ${envName}="${raw}": expected an integer >= ${minMs} ms; using ${defaultMs} ms`,
    );
    return defaultMs;
  }
  return parsed;
};
