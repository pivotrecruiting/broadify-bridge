import type { EngineConnectConfig } from "./engine-adapter-interface.js";
import type { EngineReconnectInfoT, EngineStatusT } from "../engine-types.js";
import { ReconnectScheduler } from "../shared/backoff.js";

export const STARTUP_AUTO_CONNECT_DELAY_MS = 3000;
export const STARTUP_MAX_ATTEMPTS = 5;
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER_RATIO = 0.2;
export const SELF_HEAL_GRACE_MS = 30_000;

type EngineConnectOriginT = "manual" | "startup";
type SchedulerKindT = "startup" | "session";
type TimerT = ReturnType<typeof setTimeout>;

type EngineConnectionSupervisorDepsT = {
  driver: {
    open(config: EngineConnectConfig, origin?: EngineConnectOriginT): Promise<void>;
    close(): Promise<void>;
  };
  getStatus: () => EngineStatusT;
  onReconnectStateChange: (info: EngineReconnectInfoT | null) => void;
  createScheduler?: (kind: SchedulerKindT) => ReconnectScheduler;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
};

export class EngineConnectionSupervisor {
  private desired: EngineConnectConfig | null = null;
  private shutdownRequested = false;
  private generation = 0;
  private readonly sessionScheduler: ReconnectScheduler;
  private readonly startupScheduler: ReconnectScheduler;
  private selfHealTimer: TimerT | null = null;
  private readonly deps: Required<
    Omit<
      EngineConnectionSupervisorDepsT,
      "logger" | "createScheduler" | "random"
    >
  > &
    Pick<EngineConnectionSupervisorDepsT, "logger" | "random">;

  constructor(deps: EngineConnectionSupervisorDepsT) {
    this.deps = {
      now: Date.now,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      ...deps,
    };
    this.sessionScheduler =
      deps.createScheduler?.("session") ??
      new ReconnectScheduler({
        baseMs: RECONNECT_BASE_DELAY_MS,
        maxMs: RECONNECT_MAX_DELAY_MS,
        jitterRatio: RECONNECT_JITTER_RATIO,
        setTimeoutFn: this.deps.setTimeoutFn ?? setTimeout,
        clearTimeoutFn: this.deps.clearTimeoutFn ?? clearTimeout,
        now: this.deps.now,
        random: deps.random,
      });
    this.startupScheduler =
      deps.createScheduler?.("startup") ??
      new ReconnectScheduler({
        baseMs: RECONNECT_BASE_DELAY_MS,
        maxMs: RECONNECT_MAX_DELAY_MS,
        jitterRatio: 0,
        setTimeoutFn: this.deps.setTimeoutFn ?? setTimeout,
        clearTimeoutFn: this.deps.clearTimeoutFn ?? clearTimeout,
        now: this.deps.now,
        random: deps.random,
      });
  }

  async connect(
    config: EngineConnectConfig,
    origin: EngineConnectOriginT
  ): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.shutdownRequested = false;
    this.desired = config;
    this.clearSelfHealTimer();
    if (origin === "manual") {
      this.cancelPending();
      await this.deps.driver.open(config, origin);
      if (generation !== this.generation) {
        return;
      }
      this.sessionScheduler.reset();
      this.deps.onReconnectStateChange(null);
      return;
    }

    this.startupScheduler.reset();
    await this.runStartupAttempt(generation);
  }

  async disconnect(): Promise<void> {
    this.desired = null;
    this.generation += 1;
    this.cancelPending();
    await this.deps.driver.close();
  }

  beginShutdown(): void {
    this.shutdownRequested = true;
    this.desired = null;
    this.generation += 1;
    this.cancelPending();
  }

  cancelPending(): void {
    this.sessionScheduler.cancel();
    this.startupScheduler.cancel();
    this.clearSelfHealTimer();
    this.deps.onReconnectStateChange(null);
  }

  handleSessionStatus(prev: EngineStatusT, next: EngineStatusT): void {
    if (!this.desired || this.shutdownRequested) {
      return;
    }
    if (prev === "connected" && next === "connected") {
      this.clearSelfHealTimer();
      return;
    }
    if (prev === "connected" && next === "connecting") {
      this.armSelfHealGrace(this.generation);
      return;
    }
    if (
      prev === "connected" &&
      (next === "disconnected" || next === "error")
    ) {
      this.sessionScheduler.cancel();
      void this.deps.driver.close();
      this.scheduleSessionReconnect(this.generation);
    }
  }

  private async runStartupAttempt(generation: number): Promise<void> {
    const config = this.desired;
    if (!config || this.shutdownRequested || generation !== this.generation) {
      return;
    }
    try {
      await this.deps.driver.open(config, "startup");
      if (generation !== this.generation) {
        return;
      }
      this.startupScheduler.reset();
      this.deps.onReconnectStateChange(null);
    } catch (error) {
      if (generation !== this.generation || !this.desired) {
        return;
      }
      if (this.startupScheduler.attempt >= STARTUP_MAX_ATTEMPTS - 1) {
        this.deps.logger?.info?.("[Engine] Startup auto-connect gave up");
        this.desired = null;
        await this.deps.driver.close();
        this.deps.onReconnectStateChange(null);
        return;
      }
      const scheduled = this.startupScheduler.schedule(() =>
        this.runStartupAttempt(generation)
      );
      if (!scheduled) {
        this.deps.logger?.info?.("[Engine] Startup auto-connect gave up");
        this.desired = null;
        await this.deps.driver.close();
        this.deps.onReconnectStateChange(null);
        return;
      }
      this.deps.onReconnectStateChange({
        attempt: this.startupScheduler.attempt,
        nextRetryAt: this.startupScheduler.getNextRetryAt(),
        lastError: this.errorMessage(error),
      });
    }
  }

  private async startSessionReconnect(generation: number): Promise<void> {
    this.sessionScheduler.cancel();
    void this.deps.driver.close();
    if (!this.desired || this.shutdownRequested || generation !== this.generation) {
      return;
    }
    this.scheduleSessionReconnect(generation);
  }

  private scheduleSessionReconnect(generation: number, lastError?: string): void {
    const scheduled = this.sessionScheduler.schedule(() =>
      this.runSessionReconnectAttempt(generation)
    );
    if (!scheduled) {
      return;
    }
    this.deps.onReconnectStateChange({
      attempt: this.sessionScheduler.attempt,
      nextRetryAt: this.sessionScheduler.getNextRetryAt(),
      lastError,
    });
  }

  private async runSessionReconnectAttempt(generation: number): Promise<void> {
    const config = this.desired;
    if (!config || this.shutdownRequested || generation !== this.generation) {
      return;
    }
    try {
      await this.deps.driver.open(config, "startup");
      if (generation !== this.generation) {
        return;
      }
      this.sessionScheduler.reset();
      this.deps.onReconnectStateChange(null);
    } catch (error) {
      if (!this.desired || generation !== this.generation) {
        return;
      }
      this.scheduleSessionReconnect(generation, this.errorMessage(error));
    }
  }

  private armSelfHealGrace(generation: number): void {
    this.clearSelfHealTimer();
    this.selfHealTimer = this.deps.setTimeoutFn(() => {
      this.selfHealTimer = null;
      if (this.deps.getStatus() === "connected") {
        return;
      }
      void this.startSessionReconnect(generation);
    }, SELF_HEAL_GRACE_MS);
    this.selfHealTimer.unref?.();
  }

  private clearSelfHealTimer(): void {
    if (!this.selfHealTimer) {
      return;
    }
    this.deps.clearTimeoutFn(this.selfHealTimer);
    this.selfHealTimer = null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
