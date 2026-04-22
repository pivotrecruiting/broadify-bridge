import type {
  MacroExecutionStatusT,
  MacroExecutionT,
} from "../engine-types.js";

type StartPendingParamsT = {
  macroId: number;
  macroName?: string;
  engineType: MacroExecutionT["engineType"];
  now?: () => number;
  runIdFactory?: () => string;
};

type MarkDeviceStateParamsT = {
  macroId: number;
  macroName?: string;
  engineType: MacroExecutionT["engineType"];
  status: Extract<MacroExecutionStatusT, "running" | "waiting">;
  loop: boolean;
  now?: () => number;
  runIdFactory?: () => string;
};

const defaultNow = (): number => Date.now();

const defaultRunIdFactory = (): string => {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const cloneExecution = (
  execution: MacroExecutionT | null
): MacroExecutionT | null => {
  if (!execution) {
    return null;
  }

  return { ...execution };
};

/**
 * Tracks a single active macro execution and the most recent completed/stopped run.
 */
export class EngineMacroExecutionStore {
  private activeExecution: MacroExecutionT | null = null;
  private lastCompletedExecution: MacroExecutionT | null = null;

  startPending(params: StartPendingParamsT): MacroExecutionT {
    const now = params.now ? params.now() : defaultNow();
    const runId = params.runIdFactory
      ? params.runIdFactory()
      : defaultRunIdFactory();

    this.activeExecution = {
      runId,
      macroId: params.macroId,
      macroName: params.macroName,
      engineType: params.engineType,
      status: "pending",
      triggeredAt: now,
      acceptedAt: null,
      startedAt: null,
      waitingAt: null,
      completedAt: null,
      actualDurationMs: null,
      loop: false,
      stopRequestedAt: null,
    };

    return this.getActiveExecution() as MacroExecutionT;
  }

  markDeviceState(params: MarkDeviceStateParamsT): MacroExecutionT {
    const now = params.now ? params.now() : defaultNow();

    if (
      !this.activeExecution ||
      this.activeExecution.macroId !== params.macroId
    ) {
      const runId = params.runIdFactory
        ? params.runIdFactory()
        : defaultRunIdFactory();

      this.activeExecution = {
        runId,
        macroId: params.macroId,
        macroName: params.macroName,
        engineType: params.engineType,
        status: params.status,
        triggeredAt: now,
        acceptedAt: null,
        startedAt: now,
        waitingAt: params.status === "waiting" ? now : null,
        completedAt: null,
        actualDurationMs: null,
        loop: params.loop,
        stopRequestedAt: null,
      };

      return this.getActiveExecution() as MacroExecutionT;
    }

    this.activeExecution.macroName =
      params.macroName ?? this.activeExecution.macroName;
    this.activeExecution.loop = params.loop;

    if (this.activeExecution.startedAt === null) {
      this.activeExecution.startedAt = now;
    }

    if (params.status === "waiting" && this.activeExecution.waitingAt === null) {
      this.activeExecution.waitingAt = now;
    }

    this.activeExecution.status = params.status;

    return this.getActiveExecution() as MacroExecutionT;
  }

  markAccepted(now: () => number = defaultNow): MacroExecutionT | null {
    if (!this.activeExecution) {
      return null;
    }

    if (this.activeExecution.status !== "pending") {
      return this.getActiveExecution();
    }

    this.activeExecution.acceptedAt = now();
    return this.getActiveExecution();
  }

  requestStop(now: () => number = defaultNow): MacroExecutionT | null {
    if (!this.activeExecution) {
      return null;
    }

    this.activeExecution.stopRequestedAt = now();
    return this.getActiveExecution();
  }

  clearStopRequest(): MacroExecutionT | null {
    if (!this.activeExecution) {
      return null;
    }

    this.activeExecution.stopRequestedAt = null;
    return this.getActiveExecution();
  }

  markInactive(now: () => number = defaultNow): MacroExecutionT | null {
    if (!this.activeExecution) {
      return null;
    }

    if (this.activeExecution.status === "pending") {
      if (
        this.activeExecution.acceptedAt === null ||
        this.activeExecution.acceptedAt === undefined
      ) {
        return this.getActiveExecution();
      }

      const completedAt = now();
      const finished: MacroExecutionT = {
        ...this.activeExecution,
        status: "completed",
        completedAt,
        actualDurationMs: null,
      };

      this.activeExecution = null;
      this.lastCompletedExecution = finished;

      return { ...finished };
    }

    const completedAt = now();
    const startedAt = this.activeExecution.startedAt;
    const finished: MacroExecutionT = {
      ...this.activeExecution,
      status:
        this.activeExecution.stopRequestedAt !== null ? "stopped" : "completed",
      completedAt,
      actualDurationMs:
        startedAt !== null ? Math.max(0, completedAt - startedAt) : null,
    };

    this.activeExecution = null;
    this.lastCompletedExecution = finished;

    return { ...finished };
  }

  fail(error: string, now: () => number = defaultNow): MacroExecutionT | null {
    if (!this.activeExecution) {
      return null;
    }

    const completedAt = now();
    const startedAt = this.activeExecution.startedAt;
    this.activeExecution = {
      ...this.activeExecution,
      status: "failed",
      error,
      completedAt,
      actualDurationMs:
        startedAt !== null ? Math.max(0, completedAt - startedAt) : null,
    };

    return this.getActiveExecution();
  }

  getActiveExecution(): MacroExecutionT | null {
    return cloneExecution(this.activeExecution);
  }

  getLastCompletedExecution(): MacroExecutionT | null {
    return cloneExecution(this.lastCompletedExecution);
  }

  reset(): void {
    this.activeExecution = null;
    this.lastCompletedExecution = null;
  }
}
