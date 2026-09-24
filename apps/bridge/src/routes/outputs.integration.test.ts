import Fastify from "fastify";
import { registerOutputsRoute } from "./outputs.js";

const mockGetDevices = jest.fn().mockResolvedValue([]);
jest.mock("../services/device-cache.js", () => ({
  deviceCache: {
    getDevices: (...args: unknown[]) => mockGetDevices(...args),
  },
}));

const mockGraphicsGetStatus = jest.fn(() => ({ outputConfig: null }));
jest.mock("../services/graphics/graphics-manager.js", () => ({
  graphicsManager: {
    getStatus: () => mockGraphicsGetStatus(),
  },
}));

jest.mock("../services/output-diagnostics.js", () => ({
  buildOutputsDiagnostics: jest.fn(() => ({
    platform: "darwin",
    decklink: { state: "ok" },
  })),
  getDecklinkDeviceCount: jest.fn((devices: Array<{ type?: string }>) =>
    devices.filter((device) => device.type === "decklink").length
  ),
}));

const mockEnforceLocalOrToken = jest.fn().mockReturnValue(true);
jest.mock("./route-guards.js", () => ({
  enforceLocalOrToken: (...args: unknown[]) => mockEnforceLocalOrToken(...args),
}));

describe("registerOutputsRoute integration", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEnforceLocalOrToken.mockReturnValue(true);
    mockGraphicsGetStatus.mockReturnValue({ outputConfig: null });
    mockGetDevices.mockResolvedValue([
      {
        id: "deck-1",
        displayName: "DeckLink",
        type: "decklink",
        ports: [
          {
            id: "port-fill",
            displayName: "SDI Fill",
            type: "sdi",
            role: "fill",
            direction: "output",
            status: { available: true },
            capabilities: { formats: [], modes: [] },
          },
          {
            id: "port-key",
            displayName: "SDI Key",
            type: "sdi",
            role: "key",
            direction: "output",
            status: { available: true },
            capabilities: { formats: [], modes: [] },
          },
        ],
        status: { present: true, inUse: false, ready: true, lastSeen: Date.now() },
      },
    ]);
    app = Fastify();
    await app.register(registerOutputsRoute);
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /outputs returns output1 and output2 arrays", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/outputs",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("output1");
    expect(body).toHaveProperty("output2");
    expect(body).toHaveProperty("diagnostics");
    expect(Array.isArray(body.output1)).toBe(true);
    expect(Array.isArray(body.output2)).toBe(true);
    expect(mockGetDevices).toHaveBeenCalledWith(false, ["display", "decklink"]);
  });

  it("GET /outputs?refresh=1 calls getDevices with true", async () => {
    await app.inject({
      method: "GET",
      url: "/outputs?refresh=1",
    });

    expect(mockGetDevices).toHaveBeenCalledWith(true, ["display", "decklink"]);
  });

  it("transforms decklink device ports to output1 (fill) and output2 (key)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/outputs",
    });

    const body = response.json();
    expect(body.output1).toHaveLength(1);
    expect(body.output2).toHaveLength(1);
    expect(body.output1[0]).toMatchObject({
      id: "port-fill",
      type: "decklink",
      deviceId: "deck-1",
      portType: "sdi",
      portRole: "fill",
      available: true,
    });
    expect(body.output2[0]).toMatchObject({
      id: "port-key",
      portRole: "key",
    });
  });

  it("marks active output ports as owned and available", async () => {
    mockGraphicsGetStatus.mockReturnValue({
      outputConfig: {
        targets: { output1Id: "port-fill", output2Id: "port-key" },
      },
    });
    mockGetDevices.mockResolvedValueOnce([
      {
        id: "deck-1",
        displayName: "DeckLink",
        type: "decklink",
        ports: [
          {
            id: "port-fill",
            displayName: "SDI Fill",
            type: "sdi",
            role: "fill",
            direction: "output",
            status: { available: false },
            capabilities: { formats: [], modes: [] },
          },
          {
            id: "port-key",
            displayName: "SDI Key",
            type: "sdi",
            role: "key",
            direction: "output",
            status: { available: false },
            capabilities: { formats: [], modes: [] },
          },
        ],
        status: { present: true, inUse: true, ready: false, lastSeen: Date.now() },
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/outputs",
    });

    expect(response.json()).toMatchObject({
      output1: [{ id: "port-fill", available: true, ownedByBridge: true }],
      output2: [{ id: "port-key", available: true, ownedByBridge: true }],
    });
  });

  it("returns 500 when deviceCache.getDevices fails", async () => {
    mockGetDevices.mockRejectedValueOnce(new Error("Cache error"));

    const response = await app.inject({
      method: "GET",
      url: "/outputs",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: "Failed to get outputs",
      message: "Cache error",
    });
  });

  it("returns 429 when error message includes Rate limit", async () => {
    mockGetDevices.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const response = await app.inject({
      method: "GET",
      url: "/outputs",
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: "Rate limit exceeded",
    });
  });
});
