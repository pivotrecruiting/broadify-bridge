import Fastify from "fastify";
import { EngineError, EngineErrorCode } from "../services/engine/engine-errors.js";
import type { EngineStatusT } from "../services/engine-types.js";
import { registerEngineRoute } from "./engine.js";

const createEngineAdapterFake = () => {
  const state = {
    status: "disconnected" as EngineStatusT,
    macros: [] as { id: number; name: string; status: "idle" }[],
    macroExecution: null as null | Record<string, unknown>,
    lastCompletedMacroExecution: null as null | Record<string, unknown>,
  };

  return {
    connect: jest.fn(async (config: { type: string; ip: string; port: number }) => {
      state.status = "connected";
      Object.assign(state, config);
    }),
    disconnect: jest.fn(async () => {
      state.status = "disconnected";
      state.macros = [];
    }),
    getState: jest.fn(() => ({ ...state })),
    getConnectedSince: jest.fn(() => 1234567890),
    getLastError: jest.fn(() => null),
    getMacros: jest.fn(() => state.macros),
    getStatus: jest.fn(() => state.status),
    runMacro: jest.fn(async (_macroId: number) => undefined),
    stopMacro: jest.fn(async (_macroId: number) => undefined),
    runVmixAction: jest.fn(
      async (action: { actionType: "script_start" | "script_stop"; scriptName: string }) => ({
        ...action,
        executedFunction:
          action.actionType === "script_start" ? "ScriptStart" : "ScriptStop",
      })
    ),
    __setState: (next: Partial<typeof state>) => {
      Object.assign(state, next);
    },
  };
};

describe("registerEngineRoute integration", () => {
  it("connects successfully via POST /engine/connect", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/connect",
      payload: {
        type: "atem",
        ip: "10.0.0.10",
        port: 9910,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(engineAdapter.connect).toHaveBeenCalledWith({
      type: "atem",
      ip: "10.0.0.10",
      port: 9910,
    });
    expect(response.json()).toEqual({
      success: true,
      state: expect.objectContaining({
        status: "connected",
        type: "atem",
        ip: "10.0.0.10",
        port: 9910,
      }),
    });

    await app.close();
  });

  it("returns 400 for invalid connect payload", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/connect",
      payload: {
        ip: "10.0.0.10",
        port: 9910,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      success: false,
      error: expect.objectContaining({
        code: "VALIDATION_ERROR",
      }),
    });

    await app.close();
  });

  it("maps EngineError to the correct http status", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.connect.mockRejectedValueOnce(
      new EngineError(EngineErrorCode.CONNECTION_TIMEOUT, "timed out"),
    );

    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/connect",
      payload: {
        type: "atem",
        ip: "10.0.0.10",
        port: 9910,
      },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({
      success: false,
      error: expect.objectContaining({
        code: "CONNECTION_TIMEOUT",
        message: "timed out",
      }),
    });

    await app.close();
  });

  it("returns 503 from GET /engine/macros when engine is not connected", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "disconnected" });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/engine/macros",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      error: "Engine not connected",
      message: "Engine status: disconnected",
      macros: [],
    });

    await app.close();
  });

  it("returns 401 when auth fails in preHandler", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => ({ status: 401, message: "Unauthorized" }),
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/engine/status",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      },
    });

    await app.close();
  });

  it("POST /engine/disconnect returns success and state", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/disconnect",
    });

    expect(response.statusCode).toBe(200);
    expect(engineAdapter.disconnect).toHaveBeenCalled();
    expect(response.json()).toEqual({
      success: true,
      state: expect.objectContaining({ status: "disconnected" }),
    });
    await app.close();
  });

  it("GET /engine/status returns state and connectedSince", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "connected" });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/engine/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      state: expect.objectContaining({ status: "connected" }),
    });
    await app.close();
  });

  it("POST /engine/macros/:id/run returns 400 for invalid macro ID", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "connected" });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/macros/not-a-number/run",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      error: "Invalid macro ID",
      message: "Macro ID must be a number",
    });
    await app.close();
  });

  it("POST /engine/vmix/actions/run executes a documented vMix action", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "connected", type: "vmix" as any });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/vmix/actions/run",
      payload: {
        actionType: "script_start",
        scriptName: "Broadify_Button_1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(engineAdapter.runVmixAction).toHaveBeenCalledWith({
      actionType: "script_start",
      scriptName: "Broadify_Button_1",
    });
    expect(response.json()).toMatchObject({
      success: true,
      action: {
        actionType: "script_start",
        scriptName: "Broadify_Button_1",
        executedFunction: "ScriptStart",
      },
    });

    await app.close();
  });

  it("POST /engine/macros/:id/run returns success when connected", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "connected" });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/macros/1/run",
    });

    expect(response.statusCode).toBe(200);
    expect(engineAdapter.runMacro).toHaveBeenCalledWith(1);
    expect(response.json()).toMatchObject({
      success: true,
      macroId: 1,
      execution: null,
    });
    await app.close();
  });

  it("POST /engine/macros/:id/run returns 503 when not connected", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "disconnected" });
    engineAdapter.runMacro.mockRejectedValueOnce(new Error("Engine not connected"));
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/macros/1/run",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      error: "Engine not connected",
    });
    await app.close();
  });

  it("POST /engine/macros/:id/stop returns 400 for invalid macro ID", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "connected" });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/macros/abc/stop",
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("POST /engine/macros/:id/stop returns success when connected", async () => {
    const app = Fastify();
    const engineAdapter = createEngineAdapterFake();
    engineAdapter.__setState({ status: "connected" });
    await app.register(registerEngineRoute, {
      engineAdapter,
      getAuthFailure: () => null,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/engine/macros/2/stop",
    });

    expect(response.statusCode).toBe(200);
    expect(engineAdapter.stopMacro).toHaveBeenCalledWith(2);
    expect(response.json()).toMatchObject({
      success: true,
      macroId: 2,
      execution: null,
    });
    await app.close();
  });
});
