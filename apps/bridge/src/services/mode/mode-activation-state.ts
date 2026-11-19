import type { BridgeModeT } from "@broadify/protocol";

/**
 * Which web-app modes have been activated on this bridge since it started.
 *
 * Deliberately dependency-free: the engine adapter consults it to decide
 * whether a failing Studio restore is worth an `engine_error` bridge event,
 * and the mode activation service records into it. Neither side has to know
 * the other (no import cycle through the command router).
 */
export class ModeActivationState {
  private readonly activatedModes = new Set<BridgeModeT>();

  recordActivation(mode: BridgeModeT): void {
    this.activatedModes.add(mode);
  }

  hasActivatedMode(mode: BridgeModeT): boolean {
    return this.activatedModes.has(mode);
  }

  /** Activated modes in activation order (a Set keeps insertion order). */
  getActivatedModes(): BridgeModeT[] {
    return Array.from(this.activatedModes);
  }

  /**
   * True once a mode that restores Studio connections (studio, conference)
   * has been activated. Meeting alone keeps the bridge quiet about Studio.
   */
  isStudioRestoreActive(): boolean {
    return this.activatedModes.has("studio") || this.activatedModes.has("conference");
  }

  /** Test helper: forget every activation. */
  reset(): void {
    this.activatedModes.clear();
  }
}

/** Process-wide activation state shared by the engine adapter and the service. */
export const modeActivationState = new ModeActivationState();
