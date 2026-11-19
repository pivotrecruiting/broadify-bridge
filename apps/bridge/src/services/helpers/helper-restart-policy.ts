/**
 * Bounded crash recovery shared by the native helper managers (meeting, pgm):
 * up to `maxAttempts` respawns with exponential backoff, and a helper that
 * stayed up for `healthyUptimeMs` counts as recovered so the attempt counter
 * starts again from zero for the next, unrelated crash.
 *
 * Pure: no timers, no I/O. The manager owns the timer and the state object.
 */
export type HelperRestartPolicyConfigT = {
  maxAttempts: number;
  baseDelayMs: number;
  healthyUptimeMs: number;
};

export type HelperRestartStateT = {
  attempts: number;
};

export type HelperRestartDecisionT =
  | { action: "restart"; attempt: number; delayMs: number }
  | { action: "give_up"; attempts: number };

export const DEFAULT_HELPER_RESTART_POLICY: HelperRestartPolicyConfigT = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  healthyUptimeMs: 60_000,
};

export function createHelperRestartState(): HelperRestartStateT {
  return { attempts: 0 };
}

/** Call on every crash before deciding: a healthy run resets the budget. */
export function noteHelperCrash(
  state: HelperRestartStateT,
  uptimeMs: number,
  config: HelperRestartPolicyConfigT = DEFAULT_HELPER_RESTART_POLICY,
): HelperRestartStateT {
  return uptimeMs >= config.healthyUptimeMs ? { attempts: 0 } : state;
}

/** Decide whether to schedule another respawn; mutates nothing, returns the next state alongside. */
export function decideHelperRestart(
  state: HelperRestartStateT,
  config: HelperRestartPolicyConfigT = DEFAULT_HELPER_RESTART_POLICY,
): { decision: HelperRestartDecisionT; state: HelperRestartStateT } {
  if (state.attempts >= config.maxAttempts) {
    return { decision: { action: "give_up", attempts: state.attempts }, state };
  }
  const attempt = state.attempts + 1;
  return {
    decision: { action: "restart", attempt, delayMs: config.baseDelayMs * 2 ** (attempt - 1) },
    state: { attempts: attempt },
  };
}
