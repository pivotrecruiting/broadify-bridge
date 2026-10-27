import type {
  BridgeModeT,
  ModeActivateResultT,
  ModeActivationRestoreTargetT,
} from "@broadify/protocol";
import { engineAdapter } from "../engine-adapter.js";
import { graphicsManager } from "../graphics/graphics-manager.js";
import { getBridgeContext, type LoggerLikeT } from "../bridge-context.js";
import { ModeActivationState, modeActivationState } from "./mode-activation-state.js";

/** Modes the web app can activate; mirrors `BridgeModeT` for the zod schema. */
export const BRIDGE_MODES = ["studio", "meeting", "conference"] as const satisfies readonly BridgeModeT[];

type ModeActivationServiceDepsT = {
  state: ModeActivationState;
  /** Schedules the persisted engine auto-connect (idempotent on the adapter). */
  startEngineAutoConnect: () => void;
  /** Applies the persisted Studio output config (idempotent on the manager). */
  applyPersistedGraphicsOutput: () => Promise<void>;
  logger?: LoggerLikeT;
};

/**
 * Mode-driven Studio restoration.
 *
 * The bridge has no notion of Studio/Meeting/Conference on its own; the web
 * app's root page is the mode selection. Since rc.19 field findings showed the
 * bridge restoring Studio state (persisted ATEM, persisted graphics output)
 * while the operator was in a meeting, the restore moved behind this command:
 * the web app announces its mode, and only studio/conference restore anything.
 *
 * Safe to call repeatedly and from several clients: the underlying restores
 * are no-ops once they ran, and the activation set only grows.
 */
export class ModeActivationService {
  constructor(private readonly deps: ModeActivationServiceDepsT) {}

  /**
   * Activate a web-app mode.
   *
   * @returns What was triggered (not what succeeded; outcomes arrive through
   * `engine_status` / `graphics_status` events and `get_status`).
   */
  async activate(mode: BridgeModeT): Promise<ModeActivateResultT> {
    this.deps.state.recordActivation(mode);
    const logger = this.deps.logger ?? getBridgeContext().logger;

    if (mode === "meeting") {
      logger.info("[ModeActivation] meeting activated; Studio restore skipped");
      return { mode, restored: [] };
    }

    const restored: ModeActivationRestoreTargetT[] = [];
    this.deps.startEngineAutoConnect();
    restored.push("engine_autoconnect");
    // Awaited so the serial side-effect lane keeps a following
    // graphics_configure_outputs behind the persisted apply.
    await this.deps.applyPersistedGraphicsOutput();
    restored.push("graphics_output");

    logger.info(
      `[ModeActivation] ${mode} activated; restored=${restored.join(",")}`
    );
    return { mode, restored };
  }

  getActivatedModes(): BridgeModeT[] {
    return this.deps.state.getActivatedModes();
  }
}

/** Singleton wired to the process-wide engine adapter and Studio graphics manager. */
export const modeActivationService = new ModeActivationService({
  state: modeActivationState,
  startEngineAutoConnect: () => engineAdapter.startPersistedAutoConnect(),
  applyPersistedGraphicsOutput: () => graphicsManager.applyPersistedOutput(),
});
