import type { DeviceDescriptorT } from "@broadify/protocol";
import type { LoggerLikeT } from "../bridge-context.js";
import { ReconnectScheduler } from "../shared/backoff.js";
import type { DeviceCacheChangeT } from "../device-cache.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";

export type GraphicsOutputRecoveryReasonT =
  | "init_failed"
  | "helper_exit"
  | "device_changed";

export type GraphicsOutputRecoveryStateT = {
  active: boolean;
  reason: GraphicsOutputRecoveryReasonT | null;
  attempt: number;
  nextRetryAt: number | null;
  config: GraphicsOutputConfigT | null;
};

type GraphicsOutputSupervisorDepsT = {
  reapply: (config: GraphicsOutputConfigT) => Promise<void>;
  subscribeDevices: (
    cb: (change: DeviceCacheChangeT) => void,
  ) => () => void;
  createScheduler: () => ReconnectScheduler;
  isTargetPresent: (config: GraphicsOutputConfigT) => boolean | Promise<boolean>;
  publishStatus: (reason: string) => void;
  logger: LoggerLikeT;
  now: () => number;
};

export class GraphicsOutputSupervisor {
  private scheduler: ReconnectScheduler;
  private unsubscribeDevices: (() => void) | null = null;
  private active = false;
  private reason: GraphicsOutputRecoveryReasonT | null = null;
  private config: GraphicsOutputConfigT | null = null;
  private running = false;

  constructor(private readonly deps: GraphicsOutputSupervisorDepsT) {
    this.scheduler = deps.createScheduler();
  }

  start(params: {
    reason: GraphicsOutputRecoveryReasonT;
    config: GraphicsOutputConfigT;
  }): void {
    this.active = true;
    this.reason = params.reason;
    this.config = params.config;
    this.ensureDeviceSubscription();
    this.scheduleNext();
  }

  cancel(reason: string): void {
    this.deps.logger.debug?.(`[GraphicsOutputSupervisor] Cancelled: ${reason}`);
    this.active = false;
    this.reason = null;
    this.config = null;
    this.running = false;
    this.scheduler.cancel();
  }

  reset(): void {
    this.scheduler.reset();
    this.active = false;
    this.reason = null;
    this.config = null;
    this.running = false;
  }

  getState(): GraphicsOutputRecoveryStateT {
    return {
      active: this.active,
      reason: this.reason,
      attempt: this.scheduler.attempt,
      nextRetryAt: this.scheduler.getNextRetryAt(),
      config: this.config,
    };
  }

  private ensureDeviceSubscription(): void {
    if (this.unsubscribeDevices) {
      return;
    }
    this.unsubscribeDevices = this.deps.subscribeDevices((change) => {
      void this.handleDeviceChange(change);
    });
  }

  private scheduleNext(): void {
    if (!this.active || !this.config) {
      return;
    }
    const scheduled = this.scheduler.schedule(() => this.runAttempt());
    if (!scheduled) {
      this.deps.logger.error(
        "[GraphicsOutputSupervisor] Recovery attempts exhausted; waiting for device change",
      );
    }
    this.deps.publishStatus("output_recovery_scheduled");
  }

  private async handleDeviceChange(change: DeviceCacheChangeT): Promise<void> {
    if (!this.active || !this.config) {
      return;
    }
    const targetIds = this.getTargetPortIds(this.config);
    if (!change.added.some((id) => targetIds.includes(id))) {
      return;
    }
    if (!(await this.deps.isTargetPresent(this.config))) {
      return;
    }
    this.scheduler.reset();
    await this.runAttempt("device_changed");
  }

  private async runAttempt(
    reason: GraphicsOutputRecoveryReasonT | null = null,
  ): Promise<void> {
    if (!this.active || !this.config || this.running) {
      return;
    }
    this.running = true;
    if (reason) {
      this.reason = reason;
    }
    const config = this.config;
    try {
      this.deps.publishStatus("outputs_configuring");
      await this.deps.reapply(config);
      this.reset();
      this.deps.publishStatus("outputs_configured");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        `[GraphicsOutputSupervisor] Recovery attempt failed: ${message}`,
      );
      this.running = false;
      this.scheduleNext();
      return;
    }
    this.running = false;
  }

  private getTargetPortIds(config: GraphicsOutputConfigT): string[] {
    return [config.targets.output1Id, config.targets.output2Id].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  }
}

export function hasTargetPort(
  config: GraphicsOutputConfigT,
  devices: DeviceDescriptorT[],
): boolean {
  const targetIds = [config.targets.output1Id, config.targets.output2Id].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return devices.some((device) =>
    device.ports.some((port) => targetIds.includes(port.id)),
  );
}
