import { getBridgeContext } from "../bridge-context.js";
import type {
  CiRequestMessageT,
  CiResultMessageT,
} from "../relay-client.js";
import type { UsageEventT } from "./intelligence-types.js";
import {
  ciUploadQueueStore,
  type CiUploadTaskT,
} from "./upload-queue-store.js";
import {
  graphicsUsageRecorder,
  type GraphicsUsageRecorder,
} from "./usage-event-recorder.js";
import { uploadGuardedBuffer } from "./upload-client.js";

/** Events slightly before the call start still matter (open intervals). */
const GRACE_BEFORE_MS = 5 * 60_000;
const GRACE_AFTER_MS = 5_000;
/** Fallback window when the in-memory start anchor got lost. */
const FALLBACK_CALL_LOOKBACK_MS = 6 * 60 * 60_000;
const STARTUP_DRAIN_DELAY_MS = 3000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const MAX_TASK_ATTEMPTS = 60;
const MAX_DRAIN_WAIT_MS = 5 * 60_000;

export type CiTransportT = {
  isConnected: () => boolean;
  sendCiRequest: (
    request: CiRequestMessageT,
    timeoutMs?: number,
  ) => Promise<CiResultMessageT>;
};

type QueueStoreLikeT = {
  load: () => Promise<CiUploadTaskT[]>;
  save: (tasks: CiUploadTaskT[]) => Promise<void>;
};

type RecorderLikeT = Pick<GraphicsUsageRecorder, "readEventsInRange">;

type CoordinatorDepsT = {
  queueStore?: QueueStoreLikeT;
  recorder?: RecorderLikeT;
  upload?: typeof uploadGuardedBuffer;
  now?: () => number;
  startupDrainDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxTaskAttempts?: number;
};

/**
 * Conversation Intelligence session coordinator: turns every finished call
 * into one durable upload task and drains the queue against the relay
 * broker. The drain sequence (ci_call_start → ci_call_end →
 * ci_upload_request → guarded PUT → ci_upload_complete) is idempotent
 * server-side, so it is safe to re-run in full after any failure, restart or
 * relay outage — no partial-progress bookkeeping needed. A rejected
 * ci_call_start (feature disabled, bridge unlinked) drops the task: the data
 * stays local only.
 */
export class CiSessionCoordinator {
  private readonly queueStore: QueueStoreLikeT;
  private readonly recorder: RecorderLikeT;
  private readonly upload: typeof uploadGuardedBuffer;
  private readonly now: () => number;
  private readonly startupDrainDelayMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxTaskAttempts: number;

  private transport: CiTransportT | null = null;
  private tasks: CiUploadTaskT[] = [];
  private loaded = false;
  private draining = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly activeCallStartedAt = new Map<string, number>();

  constructor(deps: CoordinatorDepsT = {}) {
    this.queueStore = deps.queueStore ?? ciUploadQueueStore;
    this.recorder = deps.recorder ?? graphicsUsageRecorder;
    this.upload = deps.upload ?? uploadGuardedBuffer;
    this.now = deps.now ?? Date.now;
    this.startupDrainDelayMs = deps.startupDrainDelayMs ?? STARTUP_DRAIN_DELAY_MS;
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
    this.maxTaskAttempts = deps.maxTaskAttempts ?? MAX_TASK_ATTEMPTS;
  }

  /** Load persisted tasks and arm the startup drain (survives restarts). */
  async initialize(): Promise<void> {
    this.tasks = await this.queueStore.load();
    this.loaded = true;
    if (this.tasks.length > 0) {
      this.scheduleDrain(this.startupDrainDelayMs);
    }
  }

  /** Wire the relay transport once it exists; arms a drain attempt. */
  attachTransport(transport: CiTransportT): void {
    this.transport = transport;
    this.scheduleDrain(this.startupDrainDelayMs);
  }

  noteCallStarted(callId: string, at: number): void {
    this.activeCallStartedAt.set(callId, at);
  }

  noteCallEnded(callId: string, at: number, reason: string): void {
    const startedAt =
      this.activeCallStartedAt.get(callId) ??
      Math.max(0, at - FALLBACK_CALL_LOOKBACK_MS);
    this.activeCallStartedAt.delete(callId);
    this.tasks.push({
      callId,
      startedAt,
      endedAt: at,
      endReason: reason,
      attempts: 0,
      nextAttemptAt: this.now(),
    });
    void this.persist();
    this.scheduleDrain(0);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    await this.persist();
  }

  /** Visible for tests. */
  getPendingTaskCount(): number {
    return this.tasks.length;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) {
      return;
    }
    await this.queueStore.save(this.tasks);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.shuttingDown || this.drainTimer) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, delayMs);
    this.drainTimer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.loaded || this.shuttingDown) {
      return;
    }
    this.draining = true;
    const logger = getBridgeContext().logger;
    try {
      for (;;) {
        const now = this.now();
        const task = this.tasks.find((entry) => entry.nextAttemptAt <= now);
        if (!task || !this.transport?.isConnected()) {
          break;
        }
        try {
          const outcome = await this.processTask(task);
          this.tasks = this.tasks.filter((entry) => entry !== task);
          logger.info(
            `[Intelligence] Call ${task.callId} ${
              outcome === "uploaded"
                ? "usage upload completed"
                : `upload skipped (${outcome})`
            }`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          task.attempts += 1;
          if (task.attempts >= this.maxTaskAttempts) {
            this.tasks = this.tasks.filter((entry) => entry !== task);
            logger.warn(
              `[Intelligence] Dropping upload task for call ${task.callId} after ${task.attempts} attempts: ${message}`,
            );
          } else {
            task.nextAttemptAt =
              this.now() +
              Math.min(
                this.retryBaseMs * 2 ** (task.attempts - 1),
                this.retryMaxMs,
              );
            if (task.attempts === 1 || task.attempts % 5 === 0) {
              logger.warn(
                `[Intelligence] Upload task for call ${task.callId} failed (attempt ${task.attempts}): ${message}`,
              );
            }
          }
        }
        await this.persist();
      }
    } finally {
      this.draining = false;
    }
    this.armNextDrain();
  }

  private armNextDrain(): void {
    if (this.shuttingDown || this.tasks.length === 0) {
      return;
    }
    const now = this.now();
    const next = Math.min(
      ...this.tasks.map((entry) => entry.nextAttemptAt),
    );
    const delay = Math.min(
      Math.max(next - now, 1000),
      MAX_DRAIN_WAIT_MS,
    );
    this.scheduleDrain(delay);
  }

  private async processTask(
    task: CiUploadTaskT,
  ): Promise<"uploaded" | string> {
    const transport = this.transport;
    if (!transport) {
      throw new Error("No relay transport attached");
    }

    const begin = await transport.sendCiRequest({
      type: "ci_call_start",
      callId: task.callId,
      startedAt: task.startedAt,
    });
    if (!begin.success) {
      throw new Error(begin.error ?? "ci_call_start failed");
    }
    if (begin.accepted === false) {
      return begin.reason ?? "rejected";
    }

    const end = await transport.sendCiRequest({
      type: "ci_call_end",
      callId: task.callId,
      endedAt: task.endedAt,
      reason: task.endReason,
    });
    if (!end.success) {
      throw new Error(end.error ?? "ci_call_end failed");
    }

    const events = await this.recorder.readEventsInRange(
      task.startedAt - GRACE_BEFORE_MS,
      task.endedAt + GRACE_AFTER_MS,
    );
    const lines = events.filter((event) =>
      isEventForCall(event, task.callId),
    );
    const body = Buffer.from(
      lines.map((event) => JSON.stringify(event)).join("\n") +
        (lines.length > 0 ? "\n" : ""),
      "utf8",
    );

    const target = await transport.sendCiRequest({
      type: "ci_upload_request",
      callId: task.callId,
      kind: "graphics",
    });
    if (!target.success || !target.uploadUrl) {
      throw new Error(target.error ?? "ci_upload_request failed");
    }

    await this.upload(target.uploadUrl, body, "application/x-ndjson");

    const complete = await transport.sendCiRequest({
      type: "ci_upload_complete",
      callId: task.callId,
      kind: "graphics",
    });
    if (!complete.success) {
      throw new Error(complete.error ?? "ci_upload_complete failed");
    }
    return "uploaded";
  }
}

function isEventForCall(event: UsageEventT, callId: string): boolean {
  if (event.type === "call_started" || event.type === "call_ended") {
    return event.call_id === callId;
  }
  return true;
}

export const ciSessionCoordinator = new CiSessionCoordinator();
