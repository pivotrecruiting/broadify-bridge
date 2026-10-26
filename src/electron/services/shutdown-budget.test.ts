import {
  APP_SHUTDOWN_TIMEOUT_MS,
  BRIDGE_STOP_GRACE_MS,
  INSTALL_CLEANUP_TIMEOUT_MS,
} from "./shutdown-budget.js";

describe("shutdown budget", () => {
  it("keeps the bridge stop grace long enough for MP4 finalization", () => {
    // The bridge's own meeting stop step waits up to ~22s for recording.stop
    // (apps/bridge/src/server.ts); SIGKILL must not arrive before that.
    expect(BRIDGE_STOP_GRACE_MS).toBe(25_000);
  });

  it("orders the budgets: bridge stop < app shutdown < install cleanup", () => {
    expect(BRIDGE_STOP_GRACE_MS).toBeLessThan(APP_SHUTDOWN_TIMEOUT_MS);
    expect(APP_SHUTDOWN_TIMEOUT_MS).toBeLessThan(INSTALL_CLEANUP_TIMEOUT_MS);
  });

  it("gives the installer a margin above the app shutdown timeout", () => {
    expect(APP_SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    expect(INSTALL_CLEANUP_TIMEOUT_MS).toBe(APP_SHUTDOWN_TIMEOUT_MS + 5_000);
  });
});
