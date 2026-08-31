import { resolvePerfLogging } from "./perf-logging.js";

describe("resolvePerfLogging", () => {
  it("always reports for meeting planes, at the calm 5s cadence", () => {
    // Field analysis of the Windows meeting complaints stalled on "no numbers
    // from the field" - no customer sets BRIDGE_LOG_PERF.
    expect(resolvePerfLogging(false, true)).toEqual({
      enabled: true,
      intervalMs: 5_000,
    });
  });

  it("keeps the dense 1s cadence when explicitly enabled", () => {
    expect(resolvePerfLogging(true, true)).toEqual({
      enabled: true,
      intervalMs: 1_000,
    });
    expect(resolvePerfLogging(true, false)).toEqual({
      enabled: true,
      intervalMs: 1_000,
    });
  });

  it("stays silent for studio without the env flag", () => {
    expect(resolvePerfLogging(false, false).enabled).toBe(false);
  });
});
