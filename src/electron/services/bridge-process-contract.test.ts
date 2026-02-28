import {
  buildBridgeProcessArgs,
  buildBridgeSpawnEnv,
  resolveBridgeStartConfig,
} from "./bridge-process-contract.js";

describe("resolveBridgeStartConfig", () => {
  const baseConfig = { host: "127.0.0.1", port: 8000 };

  it("keeps original config when port is available", () => {
    expect(
      resolveBridgeStartConfig({
        config: baseConfig,
        portAvailable: true,
        autoFindPort: true,
        availablePort: null,
      }),
    ).toEqual({
      success: true,
      config: baseConfig,
    });
  });

  it("returns error when port is unavailable and auto-find is disabled", () => {
    expect(
      resolveBridgeStartConfig({
        config: baseConfig,
        portAvailable: false,
        autoFindPort: false,
        availablePort: null,
      }),
    ).toEqual({
      success: false,
      error: "Port 8000 is already in use. Please choose a different port.",
    });
  });

  it("uses available fallback port when auto-find is enabled", () => {
    expect(
      resolveBridgeStartConfig({
        config: baseConfig,
        portAvailable: false,
        autoFindPort: true,
        availablePort: 8004,
      }),
    ).toEqual({
      success: true,
      config: { host: "127.0.0.1", port: 8004 },
      actualPort: 8004,
    });
  });
});

describe("buildBridgeProcessArgs", () => {
  const config = {
    host: "0.0.0.0",
    port: 8123,
    userDataDir: "/tmp/user-data",
  };

  it("builds dev args with tsx entry", () => {
    expect(
      buildBridgeProcessArgs({
        isDev: true,
        appPath: "/repo",
        resourcesPath: "/resources",
        config,
        bridgeId: "bridge-1",
        relayUrl: "wss://relay.example",
        bridgeName: "Studio A",
        relayEnabled: true,
      }),
    ).toEqual([
      "tsx",
      "/repo/apps/bridge/src/index.ts",
      "--host",
      "0.0.0.0",
      "--port",
      "8123",
      "--user-data-dir",
      "/tmp/user-data",
      "--bridge-id",
      "bridge-1",
      "--bridge-name",
      "Studio A",
      "--relay-enabled",
      "--relay-url",
      "wss://relay.example",
    ]);
  });

  it("builds production args with packaged entry", () => {
    expect(
      buildBridgeProcessArgs({
        isDev: false,
        appPath: "/repo",
        resourcesPath: "/Applications/App/resources",
        config,
      }),
    ).toEqual([
      "/Applications/App/resources/bridge/dist/index.js",
      "--host",
      "0.0.0.0",
      "--port",
      "8123",
      "--user-data-dir",
      "/tmp/user-data",
    ]);
  });
});

describe("buildBridgeSpawnEnv", () => {
  it("builds development env including pairing values", () => {
    const env = buildBridgeSpawnEnv({
      processEnv: { PATH: "/usr/bin" },
      isDev: true,
      relayEnabled: true,
      appVersion: "0.11.0",
      pairingCode: "1234",
      pairingExpiresAt: 1710000000000,
    });

    expect(env.NODE_ENV).toBe("development");
    expect(env.BROADIFY_DESKTOP_APP_VERSION).toBe("0.11.0");
    expect(env.BRIDGE_RELAY_ENABLED).toBe("true");
    expect(env.PAIRING_CODE).toBe("1234");
    expect(env.PAIRING_EXPIRES_AT).toBe("1710000000000");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("adds ELECTRON_RUN_AS_NODE in production", () => {
    const env = buildBridgeSpawnEnv({
      processEnv: {},
      isDev: false,
      relayEnabled: false,
      appVersion: "0.11.0",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.BROADIFY_DESKTOP_APP_VERSION).toBe("0.11.0");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});
