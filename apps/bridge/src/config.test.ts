import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.BRIDGE_RELAY_ENABLED = process.env.BRIDGE_RELAY_ENABLED;
    originalEnv.RELAY_ENABLED = process.env.RELAY_ENABLED;
    originalEnv.BRIDGE_ID = process.env.BRIDGE_ID;
    originalEnv.BRIDGE_NAME = process.env.BRIDGE_NAME;
    originalEnv.RELAY_URL = process.env.RELAY_URL;
    originalEnv.PAIRING_CODE = process.env.PAIRING_CODE;
    originalEnv.PAIRING_EXPIRES_AT = process.env.PAIRING_EXPIRES_AT;
    originalEnv.BRIDGE_USER_DATA_DIR = process.env.BRIDGE_USER_DATA_DIR;
    delete process.env.BRIDGE_ID;
    delete process.env.RELAY_URL;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it("returns default config for empty args", () => {
    const config = parseConfig([]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.mode).toBe("local");
  });

  it("parses --host and --port from CLI", () => {
    const config = parseConfig(["--host", "192.168.1.1", "--port", "9000"]);
    expect(config.host).toBe("192.168.1.1");
    expect(config.port).toBe(9000);
  });

  it("sets mode to lan when host is 0.0.0.0", () => {
    const config = parseConfig(["--host", "0.0.0.0"]);
    expect(config.mode).toBe("lan");
  });

  it("parses --bridge-id and --bridge-name", () => {
    const config = parseConfig([
      "--relay-enabled",
      "--bridge-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--bridge-name",
      "My Bridge",
    ]);
    expect(config.bridgeId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(config.bridgeName).toBe("My Bridge");
  });

  it("parses --relay-enabled", () => {
    delete process.env.BRIDGE_ID;
    delete process.env.RELAY_URL;
    const config = parseConfig(["--relay-enabled"]);
    expect(config.relayEnabled).toBe(true);
  });

  it("parses --relay-url and --user-data-dir", () => {
    const config = parseConfig([
      "--relay-enabled",
      "--bridge-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--relay-url",
      "wss://custom.relay.example",
      "--user-data-dir",
      "/tmp/bridge-data",
    ]);
    expect(config.relayUrl).toBe("wss://custom.relay.example");
    expect(config.userDataDir).toBe("/tmp/bridge-data");
  });

  it("throws on invalid host", () => {
    expect(() => parseConfig(["--host", "not-an-ip"])).toThrow();
  });

  it("throws on invalid port", () => {
    expect(() => parseConfig(["--port", "99999"])).toThrow();
  });

  it("loads relayEnabled from BRIDGE_RELAY_ENABLED env", () => {
    process.env.BRIDGE_RELAY_ENABLED = "true";
    process.env.BRIDGE_ID = "550e8400-e29b-41d4-a716-446655440000";
    process.env.RELAY_URL = "wss://relay.example.com";
    const config = parseConfig([]);
    expect(config.relayEnabled).toBe(true);
  });

  it("clears relay fields when relayEnabled is false", () => {
    const config = parseConfig(["--host", "127.0.0.1"]);
    expect(config.relayEnabled).toBe(false);
    expect(config.bridgeId).toBeUndefined();
    expect(config.relayUrl).toBeUndefined();
  });

  it("loads relayEnabled from RELAY_ENABLED env when BRIDGE_RELAY_ENABLED not set", () => {
    delete process.env.BRIDGE_RELAY_ENABLED;
    delete process.env.RELAY_ENABLED;
    process.env.RELAY_ENABLED = "1";
    process.env.BRIDGE_ID = "550e8400-e29b-41d4-a716-446655440000";
    process.env.RELAY_URL = "wss://relay.example.com";
    const config = parseConfig([]);
    expect(config.relayEnabled).toBe(true);
  });

  it("uses default relay URL when relay enabled but no URL provided", () => {
    process.env.BRIDGE_RELAY_ENABLED = "true";
    process.env.BRIDGE_ID = "550e8400-e29b-41d4-a716-446655440000";
    delete process.env.RELAY_URL;
    const config = parseConfig([]);
    expect(config.relayUrl).toBe("wss://broadify-relay.fly.dev");
  });

  it("parses --pairing-expires-at", () => {
    const ts = Math.floor(Date.now() / 1000) + 3600;
    const config = parseConfig([
      "--relay-enabled",
      "--bridge-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--pairing-code",
      "ABCD",
      "--pairing-expires-at",
      String(ts),
    ]);
    expect(config.pairingExpiresAt).toBe(ts);
  });
});
