import type { ChildProcess } from "node:child_process";

type TimerT = ReturnType<typeof setTimeout>;

type StopChildProcessOptionsT = {
  requestShutdown: () => void;
  gracefulMs: number;
  forceMs: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: (timer: TimerT) => void;
};

export function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function awaitChildExit(child: ChildProcess): Promise<void> {
  if (hasChildExited(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

export function stopChildProcessWithEscalation(
  child: ChildProcess,
  options: StopChildProcessOptionsT
): Promise<void> {
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;
  const timers: TimerT[] = [];

  return new Promise((resolve) => {
    let settled = false;

    const clearTimers = () => {
      for (const timer of timers) {
        clearTimer(timer);
      }
      timers.length = 0;
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      child.off("exit", finish);
      resolve();
    };

    child.once("exit", finish);

    try {
      options.requestShutdown();
    } catch {
      // Escalation below covers a closed or broken stdin.
    }

    if (hasChildExited(child)) {
      finish();
      return;
    }

    const sigtermTimer = setTimer(() => {
      if (hasChildExited(child)) {
        finish();
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Process already gone or not signalable; keep the bounded fallback.
      }
    }, options.gracefulMs);
    sigtermTimer.unref?.();
    timers.push(sigtermTimer);

    const sigkillTimer = setTimer(() => {
      if (!hasChildExited(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already gone or not signalable; resolve below either way.
        }
      }
      finish();
    }, options.gracefulMs + options.forceMs);
    sigkillTimer.unref?.();
    timers.push(sigkillTimer);
  });
}
