import { RELAY_COMMAND_ALLOWLIST } from "./relay-command-allowlist.js";
import {
  getRelayCommandPolicies,
  getRelayCommandPolicy,
} from "./relay-command-policy.js";

describe("relay-command-policy", () => {
  it("defines a policy for every allowed relay command", () => {
    expect(getRelayCommandPolicies().map((policy) => policy.command)).toEqual(
      RELAY_COMMAND_ALLOWLIST,
    );
  });

  it("keeps bridge local SLAs shorter than relay command timeouts", () => {
    for (const policy of getRelayCommandPolicies()) {
      expect(policy.bridgeLocalSlaMs).toBeLessThan(policy.relayTimeoutMs);
    }
  });

  it("requires complete concurrency, invalidation and response metadata", () => {
    for (const policy of getRelayCommandPolicies()) {
      expect(policy.concurrencyKey).toEqual(expect.any(String));
      expect(policy.concurrencyKey.length).toBeGreaterThan(0);
      expect(policy.invalidates.length).toBeGreaterThan(0);
      expect(["always", "same_request_id_only", "after_state_check", "never"]).toContain(
        policy.replayPolicy,
      );
      expect(["sync", "async"]).toContain(policy.responseMode);
      expect(["reject", "join_existing", "queue"]).toContain(
        policy.resourceConflictPolicy,
      );
    }
  });

  it("uses production timeout classes for long-running commands", () => {
    expect(getRelayCommandPolicy("engine_connect")).toEqual(
      expect.objectContaining({
        timeoutClass: "engine_connect",
        relayTimeoutMs: 18_000,
        executionMode: "side_effect",
      }),
    );
    expect(getRelayCommandPolicy("list_outputs")).toEqual(
      expect.objectContaining({
        timeoutClass: "list_outputs",
        relayTimeoutMs: 15_000,
        executionMode: "read_only",
      }),
    );
    expect(getRelayCommandPolicy("graphics_send")).toEqual(
      expect.objectContaining({
        timeoutClass: "graphics",
        relayTimeoutMs: 20_000,
        executionMode: "side_effect",
      }),
    );
    expect(getRelayCommandPolicy("engine_vmix_ensure_browser_input")).toEqual(
      expect.objectContaining({
        timeoutClass: "helper_start",
        responseMode: "async",
        resourceConflictPolicy: "join_existing",
        invalidates: ["engine.status", "graphics"],
      }),
    );
  });
});
