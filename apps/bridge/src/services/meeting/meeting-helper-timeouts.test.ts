import { MEETING_HELPER_RPC_TIMEOUTS_MS } from "./meeting-helper-timeouts";

// The bridge-side SLA for meeting commands is 30 s (relay-command-policy);
// every helper RPC timeout must stay below it so a slow helper call surfaces
// as a bridge error instead of a relay-level timeout.
const BRIDGE_COMMAND_SLA_MS = 30_000;

describe("MEETING_HELPER_RPC_TIMEOUTS_MS", () => {
  it("covers the camera RPCs that can legitimately exceed the 5 s default", () => {
    expect(MEETING_HELPER_RPC_TIMEOUTS_MS["camera.start"]).toBe(20_000);
    expect(MEETING_HELPER_RPC_TIMEOUTS_MS["camera.open_set"]).toBe(25_000);
  });

  it("keeps every entry above the flat default and below the bridge SLA", () => {
    for (const [method, timeoutMs] of Object.entries(
      MEETING_HELPER_RPC_TIMEOUTS_MS,
    )) {
      expect(timeoutMs).toBeGreaterThan(5_000);
      expect(timeoutMs).toBeLessThan(BRIDGE_COMMAND_SLA_MS);
      expect(method).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
