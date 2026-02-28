import Fastify from "fastify";
import { RuntimeConfigService } from "../services/runtime-config.js";
import { registerConfigRoute } from "./config.js";

const createOutputDevice = (params: {
  id: string;
  displayName?: string;
  portType: string;
}) =>
  ({
    id: params.id,
    displayName: params.displayName ?? params.id,
    type: "decklink",
    status: {
      present: true,
      ready: true,
      inUse: false,
      lastSeen: Date.now(),
    },
    ports: [
      {
        id: `${params.id}-port`,
        displayName: `${params.id} port`,
        type: params.portType,
        role: "fill",
        direction: "output",
        status: {
          available: true,
        },
        capabilities: {
          formats: [],
        },
      },
    ],
  }) as any;

describe("registerConfigRoute integration", () => {
  it("configures outputs in normal mode and opens controllers", async () => {
    const app = Fastify();
    const runtimeConfig = new RuntimeConfigService();
    const controllerOpen = jest.fn(async () => undefined);
    const getController = jest.fn(async () => ({
      open: controllerOpen,
    }));
    const getDevices = jest.fn(async () => [
      createOutputDevice({ id: "deck-1", portType: "sdi" }),
      createOutputDevice({ id: "deck-2", portType: "hdmi" }),
    ]);

    await app.register(registerConfigRoute, {
      runtimeConfig,
      moduleRegistry: {
        getController,
      },
      deviceCache: {
        getDevices,
      },
      isDevelopmentMode: () => false,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/config",
      payload: {
        outputs: {
          output1: "deck-1",
          output2: "sdi",
        },
        engine: {
          type: "atem",
          ip: "10.0.0.10",
          port: 9910,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getDevices).toHaveBeenCalledTimes(2);
    expect(getController).toHaveBeenCalledWith("deck-1");
    expect(controllerOpen).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      success: true,
      state: "active",
      outputsConfigured: true,
    });
    expect(runtimeConfig.getConfig()).toEqual({
      outputs: {
        output1: "deck-1",
        output2: "sdi",
      },
      engine: {
        type: "atem",
        ip: "10.0.0.10",
        port: 9910,
      },
    });

    await app.close();
  });

  it("skips validation and controller open in development mode", async () => {
    const app = Fastify();
    const runtimeConfig = new RuntimeConfigService();
    const getController = jest.fn();
    const getDevices = jest.fn(async () => []);

    await app.register(registerConfigRoute, {
      runtimeConfig,
      moduleRegistry: {
        getController,
      },
      deviceCache: {
        getDevices,
      },
      isDevelopmentMode: () => true,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/config",
      payload: {
        outputs: {
          output1: "missing-device",
          output2: "missing-output",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getDevices).not.toHaveBeenCalled();
    expect(getController).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      success: true,
      state: "active",
      outputsConfigured: true,
    });

    await app.close();
  });

  it("returns 400 when outputs are invalid in normal mode", async () => {
    const app = Fastify();
    const runtimeConfig = new RuntimeConfigService();
    const getController = jest.fn();
    const getDevices = jest.fn(async () => [
      createOutputDevice({ id: "deck-1", portType: "hdmi" }),
    ]);

    await app.register(registerConfigRoute, {
      runtimeConfig,
      moduleRegistry: {
        getController,
      },
      deviceCache: {
        getDevices,
      },
      isDevelopmentMode: () => false,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/config",
      payload: {
        outputs: {
          output1: "deck-1",
          output2: "sdi",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid outputs",
      message: 'Connection type "sdi" is not available',
    });
    expect(getController).not.toHaveBeenCalled();
    expect(runtimeConfig.getState()).toBe("idle");

    await app.close();
  });

  it("returns 400 for invalid request schema", async () => {
    const app = Fastify();
    const runtimeConfig = new RuntimeConfigService();

    await app.register(registerConfigRoute, {
      runtimeConfig,
      moduleRegistry: {
        getController: jest.fn(),
      },
      deviceCache: {
        getDevices: jest.fn(async () => []),
      },
      isDevelopmentMode: () => false,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/config",
      payload: {
        engine: {
          type: "atem",
          ip: "not-an-ip",
          port: 9910,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid request",
      message: expect.any(String),
    });

    await app.close();
  });

  it("clears config via POST /config/clear", async () => {
    const app = Fastify();
    const runtimeConfig = new RuntimeConfigService();
    runtimeConfig.setConfig({
      outputs: {
        output1: "deck-1",
        output2: "sdi",
      },
    });
    runtimeConfig.setActive();

    await app.register(registerConfigRoute, {
      runtimeConfig,
      moduleRegistry: {
        getController: jest.fn(),
      },
      deviceCache: {
        getDevices: jest.fn(async () => []),
      },
      isDevelopmentMode: () => false,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/config/clear",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      state: "idle",
    });
    expect(runtimeConfig.getConfig()).toBeNull();

    await app.close();
  });

  it("returns auth error when blocked by preHandler", async () => {
    const app = Fastify();
    const runtimeConfig = new RuntimeConfigService();

    await app.register(registerConfigRoute, {
      runtimeConfig,
      moduleRegistry: {
        getController: jest.fn(),
      },
      deviceCache: {
        getDevices: jest.fn(async () => []),
      },
      isDevelopmentMode: () => false,
      getAuthFailure: () => ({ status: 401, message: "Unauthorized" }),
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/config",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });

    await app.close();
  });
});
