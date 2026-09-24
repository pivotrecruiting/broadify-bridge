type TimerT = ReturnType<typeof setTimeout>;

type ComputeBackoffDelayOptionsT = {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
  random?: () => number;
};

export function computeBackoffDelayMs({
  attempt,
  baseMs,
  maxMs,
  jitterRatio,
  random = Math.random,
}: ComputeBackoffDelayOptionsT): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(baseMs * 2 ** exponent, maxMs);
  const jitter = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.round(capped * jitter));
}

type ReconnectSchedulerOptionsT = {
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
  maxAttempts?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
  random?: () => number;
};

export class ReconnectScheduler {
  private readonly options: Required<
    Omit<ReconnectSchedulerOptionsT, "maxAttempts">
  > &
    Pick<ReconnectSchedulerOptionsT, "maxAttempts">;
  private timer: TimerT | null = null;
  private currentAttempt = 0;
  private nextRetryAt: number | null = null;

  constructor(options: ReconnectSchedulerOptionsT) {
    this.options = {
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      now: Date.now,
      random: Math.random,
      ...options,
    };
  }

  schedule(run: () => Promise<void> | void): boolean {
    if (
      this.options.maxAttempts !== undefined &&
      this.currentAttempt >= this.options.maxAttempts
    ) {
      return false;
    }
    this.cancelTimerOnly();
    this.currentAttempt += 1;
    const delayMs = computeBackoffDelayMs({
      attempt: this.currentAttempt,
      baseMs: this.options.baseMs,
      maxMs: this.options.maxMs,
      jitterRatio: this.options.jitterRatio,
      random: this.options.random,
    });
    this.nextRetryAt = this.options.now() + delayMs;
    this.timer = this.options.setTimeoutFn(() => {
      this.timer = null;
      this.nextRetryAt = null;
      void run();
    }, delayMs);
    this.timer.unref?.();
    return true;
  }

  cancel(): void {
    this.cancelTimerOnly();
  }

  reset(): void {
    this.cancelTimerOnly();
    this.currentAttempt = 0;
  }

  isArmed(): boolean {
    return this.timer !== null;
  }

  get attempt(): number {
    return this.currentAttempt;
  }

  getNextRetryAt(): number | null {
    return this.nextRetryAt;
  }

  private cancelTimerOnly(): void {
    if (!this.timer) {
      this.nextRetryAt = null;
      return;
    }
    this.options.clearTimeoutFn(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
  }
}
