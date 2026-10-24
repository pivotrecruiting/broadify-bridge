import {
  createHelperRestartState,
  decideHelperRestart,
  noteHelperCrash,
  type HelperRestartPolicyConfigT,
} from "./helper-restart-policy.js";

const config: HelperRestartPolicyConfigT = { maxAttempts: 3, baseDelayMs: 1000, healthyUptimeMs: 60_000 };

describe("helper restart policy", () => {
  it("backs off exponentially and gives up after maxAttempts", () => {
    let state = createHelperRestartState();
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = decideHelperRestart(state, config);
      expect(next.decision.action).toBe("restart");
      if (next.decision.action === "restart") {
        delays.push(next.decision.delayMs);
        expect(next.decision.attempt).toBe(i + 1);
      }
      state = next.state;
    }
    expect(delays).toEqual([1000, 2000, 4000]);
    const exhausted = decideHelperRestart(state, config);
    expect(exhausted.decision).toEqual({ action: "give_up", attempts: 3 });
    expect(exhausted.state).toBe(state);
  });

  it("resets the budget after a healthy uptime, keeps it otherwise", () => {
    const state = { attempts: 2 };
    expect(noteHelperCrash(state, 59_999, config)).toBe(state);
    expect(noteHelperCrash(state, 60_000, config)).toEqual({ attempts: 0 });
  });
});
