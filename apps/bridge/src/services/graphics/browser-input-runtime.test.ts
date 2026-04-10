import { setBridgeContext } from "../bridge-context.js";
import { BrowserInputRuntime } from "./browser-input-runtime.js";

describe("BrowserInputRuntime", () => {
  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      serverHost: "127.0.0.1",
      serverPort: 8787,
      serverMode: "local",
      bridgeName: "Studio A",
    });
  });

  it("exposes browser-input urls and rewrites asset urls in layer content", () => {
    const runtime = new BrowserInputRuntime();

    runtime.configure({
      version: 1,
      outputKey: "browser_input",
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    runtime.upsertLayer({
      layerId: "lower-third-1",
      category: "lower-thirds",
      backgroundMode: "transparent",
      layout: { x: 0, y: 0, scale: 1 },
      zIndex: 10,
      presetId: undefined,
      values: { title: "Test" },
      bindings: {
        cssVariables: {},
        textContent: {},
        textTypes: {},
        animationClass: "anim-ease-out",
      },
      bundle: {
        manifest: {},
        html: '<img src="asset://logo-1" />',
        css: '.logo { background-image: url(asset://bg-1); }',
        schema: {},
        defaults: {},
        assets: [],
      },
    });

    const snapshot = runtime.getSnapshot();

    expect(snapshot.ready).toBe(true);
    expect(snapshot.browserInputUrl).toBe(
      "http://127.0.0.1:8787/graphics/browser-input"
    );
    expect(snapshot.browserInputWsUrl).toBe(
      "ws://127.0.0.1:8787/graphics/browser-input/ws"
    );
    expect(snapshot.recommendedInputName).toBe("Broadify Studio A");
    expect(snapshot.stateStatus).toBe("ready");
    expect(snapshot.stateValid).toBe(true);
    expect(snapshot.browserClientCount).toBe(0);
    expect(snapshot.layers[0]?.html).toContain(
      "/graphics/browser-input/assets/logo-1"
    );
    expect(snapshot.layers[0]?.css).toContain(
      "/graphics/browser-input/assets/bg-1"
    );
  });

  it("tracks browser clients and exposes runtime errors", () => {
    const runtime = new BrowserInputRuntime();

    runtime.configure({
      version: 1,
      outputKey: "browser_input",
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    runtime.registerBrowserClient();
    runtime.reportError("asset_missing", "Asset not found");

    const snapshot = runtime.getSnapshot();
    expect(snapshot.browserClientCount).toBe(1);
    expect(snapshot.stateStatus).toBe("error");
    expect(snapshot.stateValid).toBe(false);
    expect(snapshot.lastError).toMatchObject({
      code: "asset_missing",
      message: "Asset not found",
    });

    runtime.unregisterBrowserClient();
    expect(runtime.getSnapshot().browserClientCount).toBe(0);
  });

  it("keeps browser-input urls on loopback even when the bridge listens on lan interfaces", () => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      serverHost: "0.0.0.0",
      serverPort: 8787,
      serverMode: "lan",
      bridgeName: "Studio A",
    });

    const runtime = new BrowserInputRuntime();
    runtime.configure({
      version: 1,
      outputKey: "browser_input",
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    const snapshot = runtime.getSnapshot();

    expect(snapshot.browserInputUrl).toBe(
      "http://127.0.0.1:8787/graphics/browser-input"
    );
    expect(snapshot.browserInputWsUrl).toBe(
      "ws://127.0.0.1:8787/graphics/browser-input/ws"
    );
  });
});
