import Fastify from "fastify";
import { registerDevicesRoute } from "./devices.js";

const mockDetectAll = jest.fn().mockResolvedValue([]);
jest.mock("../modules/module-registry.js", () => ({
  moduleRegistry: {
    detectAll: () => mockDetectAll(),
  },
}));

const mockEnforceLocalOrToken = jest.fn().mockReturnValue(true);
jest.mock("./route-guards.js", () => ({
  enforceLocalOrToken: (...args: unknown[]) => mockEnforceLocalOrToken(...args),
}));

describe("registerDevicesRoute integration", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEnforceLocalOrToken.mockReturnValue(true);
    mockDetectAll.mockResolvedValue([
      {
        id: "device-1",
        displayName: "Test Device",
        type: "decklink",
        ports: [],
        status: { present: true, inUse: false, ready: true, lastSeen: Date.now() },
      },
    ]);
    app = Fastify();
    await app.register(registerDevicesRoute);
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /devices returns device list when auth passes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/devices",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "device-1", type: "decklink" });
    expect(mockDetectAll).toHaveBeenCalled();
  });

  it("GET /devices?refresh=1 forces new detection", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/devices?refresh=1",
    });

    expect(response.statusCode).toBe(200);
    expect(mockDetectAll).toHaveBeenCalled();
  });

  it("GET /devices?refresh=1 returns 429 when rate limited", async () => {
    await app.inject({ method: "GET", url: "/devices?refresh=1" });
    const response = await app.inject({
      method: "GET",
      url: "/devices?refresh=1",
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: "Rate limit exceeded",
      retryAfter: expect.any(Number),
    });
  });

  it("returns 500 when detection fails", async () => {
    mockDetectAll.mockRejectedValueOnce(new Error("Detection failed"));

    const response = await app.inject({
      method: "GET",
      url: "/devices",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: "Failed to detect devices",
      message: "Detection failed",
    });
  });

  it("does not return body when enforceLocalOrToken fails", async () => {
    mockEnforceLocalOrToken.mockImplementation((_req: unknown, reply: unknown) => {
      (reply as { code: (n: number) => { send: (v: unknown) => void } }).code(403).send({ error: "Forbidden" });
      return false;
    });

    const response = await app.inject({
      method: "GET",
      url: "/devices",
    });

    expect(response.statusCode).toBe(403);
  });
});
