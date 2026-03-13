import { isRelayCommand } from "./relay-command-allowlist.js";
import {
  EngineConnectSchema,
  parseRelayPayload,
} from "./relay-command-schemas.js";

describe("Relay command allowlist", () => {
  it("accepts known relay command", () => {
    expect(isRelayCommand("engine_connect")).toBe(true);
  });

  it("rejects unknown command", () => {
    expect(isRelayCommand("configure_outputs")).toBe(false);
  });
});

describe("relay command payload validation", () => {
  it("parses valid engine_connect payload", () => {
    const payload = parseRelayPayload(
      EngineConnectSchema,
      { type: "atem", ip: "10.0.0.15", port: 9910 },
      "Invalid payload for engine_connect",
    );

    expect(payload).toEqual({
      type: "atem",
      ip: "10.0.0.15",
      port: 9910,
    });
  });

  it("rejects engine_connect payload without type", () => {
    expect(() =>
      parseRelayPayload(
        EngineConnectSchema,
        { ip: "10.0.0.15", port: 9910 },
        "Invalid payload for engine_connect",
      ),
    ).toThrow("Invalid payload for engine_connect");
  });
});
