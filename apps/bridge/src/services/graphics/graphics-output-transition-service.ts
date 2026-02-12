import { getBridgeContext } from "../bridge-context.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import type {
  GraphicsRenderer,
  GraphicsRendererConfigT,
} from "./renderer/graphics-renderer.js";
import {
  applyFrameBusEnv,
  clearFrameBusEnv,
  type FrameBusConfigT,
} from "./framebus/framebus-config.js";

export type OutputTransitionStageT =
  | "renderer_configure"
  | "previous_adapter_stop"
  | "next_adapter_select"
  | "next_adapter_configure"
  | "persist";

type OutputTransitionRuntimeT = {
  outputConfig: GraphicsOutputConfigT | null;
  frameBusConfig: FrameBusConfigT | null;
  outputAdapter: GraphicsOutputAdapter;
};

type GraphicsOutputTransitionServiceDepsT = {
  getRenderer: () => GraphicsRenderer;
  getRuntime: () => OutputTransitionRuntimeT;
  setRuntime: (runtime: OutputTransitionRuntimeT) => void;
  selectOutputAdapter: (config: GraphicsOutputConfigT) => Promise<GraphicsOutputAdapter>;
  persistConfig: (config: GraphicsOutputConfigT) => Promise<void>;
  clearPersistedConfig: () => Promise<void>;
  resolveFrameBusConfig: (
    config: GraphicsOutputConfigT,
    previous: FrameBusConfigT | null
  ) => FrameBusConfigT;
  buildRendererConfig: (
    config: GraphicsOutputConfigT,
    frameBusConfig: FrameBusConfigT | null
  ) => GraphicsRendererConfigT;
  logFrameBusConfigChange: (
    previous: FrameBusConfigT | null,
    next: FrameBusConfigT
  ) => void;
};

/**
 * Error raised when an atomic output transition fails.
 */
export class GraphicsOutputTransitionError extends Error {
  constructor(
    public readonly stage: OutputTransitionStageT,
    message: string
  ) {
    super(message);
    this.name = "GraphicsOutputTransitionError";
  }
}

/**
 * Atomic output transition service.
 *
 * Serializes output transitions and guarantees rollback to the previous
 * runtime state if any transition stage fails.
 */
export class GraphicsOutputTransitionService {
  private transitionChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: GraphicsOutputTransitionServiceDepsT) {}

  /**
   * Wait for currently running output transition to complete.
   */
  async waitForTransition(): Promise<void> {
    await this.transitionChain;
  }

  /**
   * Apply output configuration atomically.
   *
   * @param config Validated output configuration.
   */
  async runAtomicTransition(config: GraphicsOutputConfigT): Promise<void> {
    await this.enqueue(async () => {
      await this.applyAtomic(config);
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const runPromise = this.transitionChain.then(operation, operation);
    this.transitionChain = runPromise
      .then(() => undefined)
      .catch(() => undefined);
    return runPromise;
  }

  private async applyAtomic(config: GraphicsOutputConfigT): Promise<void> {
    const previous = this.deps.getRuntime();
    const nextFrameBusConfig = this.deps.resolveFrameBusConfig(
      config,
      previous.frameBusConfig
    );
    const nextRendererConfig = this.deps.buildRendererConfig(
      config,
      nextFrameBusConfig
    );
    let nextOutputAdapter: GraphicsOutputAdapter | null = null;
    let stage: OutputTransitionStageT = "next_adapter_select";

    try {
      nextOutputAdapter = await this.deps.selectOutputAdapter(config);

      stage = "renderer_configure";
      await this.deps.getRenderer().configureSession(nextRendererConfig);

      stage = "previous_adapter_stop";
      await previous.outputAdapter.stop();

      // Output helpers consume FrameBus env vars on configure/start.
      applyFrameBusEnv(nextFrameBusConfig);

      stage = "next_adapter_configure";
      await nextOutputAdapter.configure(config);

      stage = "persist";
      await this.deps.persistConfig(config);

      this.deps.setRuntime({
        outputConfig: config,
        frameBusConfig: nextFrameBusConfig,
        outputAdapter: nextOutputAdapter,
      });
      this.deps.logFrameBusConfigChange(previous.frameBusConfig, nextFrameBusConfig);
    } catch (error) {
      const rollbackResult = await this.rollback({
        previous,
        nextOutputAdapter,
      });
      const message = error instanceof Error ? error.message : String(error);
      const rollbackSuffix = rollbackResult.ok
        ? ""
        : ` | rollback_failed=${rollbackResult.message}`;
      throw new GraphicsOutputTransitionError(stage, `${message}${rollbackSuffix}`);
    }
  }

  private async rollback(params: {
    previous: OutputTransitionRuntimeT;
    nextOutputAdapter: GraphicsOutputAdapter | null;
  }): Promise<{ ok: true } | { ok: false; message: string }> {
    const rollbackErrors: string[] = [];

    if (params.nextOutputAdapter) {
      try {
        await params.nextOutputAdapter.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rollbackErrors.push(`stop_next_adapter=${message}`);
      }
    }

    try {
      if (params.previous.frameBusConfig) {
        applyFrameBusEnv(params.previous.frameBusConfig);
      } else {
        clearFrameBusEnv();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rollbackErrors.push(`restore_framebus_env=${message}`);
    }

    if (params.previous.outputConfig) {
      try {
        const previousRendererConfig = this.deps.buildRendererConfig(
          params.previous.outputConfig,
          params.previous.frameBusConfig
        );
        await this.deps.getRenderer().configureSession(previousRendererConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rollbackErrors.push(`restore_renderer_config=${message}`);
      }

      try {
        await params.previous.outputAdapter.configure(params.previous.outputConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rollbackErrors.push(`restore_previous_adapter=${message}`);
      }
    }

    this.deps.setRuntime(params.previous);

    if (rollbackErrors.length === 0) {
      return { ok: true };
    }

    getBridgeContext().logger.error(
      `[Graphics] Output transition rollback failed: ${rollbackErrors.join(" | ")}`
    );

    clearFrameBusEnv();
    try {
      await this.deps.clearPersistedConfig();
      getBridgeContext().logger.warn(
        "[Graphics] Cleared persisted output config after rollback failure"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Failed to clear persisted output config after rollback failure: ${message}`
      );
    }

    return { ok: false, message: rollbackErrors.join(" | ") };
  }
}
