import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { engineAdapter } from "../services/engine-adapter.js";
import {
  EngineError,
  EngineErrorCode,
} from "../services/engine/engine-errors.js";
import { getAuthFailure } from "./route-guards.js";
import {
  ConnectRequestSchema,
  mapEngineErrorToStatusCode,
  VmixActionRequestSchema,
} from "./engine-contract.js";

type EngineRouteDepsT = {
  engineAdapter: Pick<
    typeof engineAdapter,
    | "connect"
    | "disconnect"
    | "getState"
    | "getConnectedSince"
    | "getLastError"
    | "getMacros"
    | "getStatus"
    | "runMacro"
    | "stopMacro"
    | "runVmixAction"
  >;
  getAuthFailure: typeof getAuthFailure;
};

type EngineRouteOptionsT = FastifyPluginOptions & Partial<EngineRouteDepsT>;

/**
 * Register engine routes.
 *
 * POST /engine/connect - Connect to engine
 * POST /engine/disconnect - Disconnect from engine
 * GET /engine/status - Get engine status
 * GET /engine/macros - Get all macros
 * POST /engine/macros/:id/run - Run macro
 * POST /engine/macros/:id/stop - Stop macro
 * POST /engine/vmix/actions/run - Execute documented vMix action
 * WS /engine/stream - WebSocket stream for real-time updates
 */
export async function registerEngineRoute(
  fastify: FastifyInstance,
  options: EngineRouteOptionsT
): Promise<void> {
  const deps: EngineRouteDepsT = {
    engineAdapter,
    getAuthFailure,
    ...options,
  };

  fastify.addHook("preHandler", async (request, reply) => {
    const authFailure = deps.getAuthFailure(request);
    if (authFailure) {
      return reply.code(authFailure.status).send({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: authFailure.message,
        },
      });
    }
  });

  /**
   * POST /engine/connect
   * Connect to engine (ATEM/Tricaster)
   */
  fastify.post("/engine/connect", async (request, reply) => {
    try {
      const body = ConnectRequestSchema.parse(request.body || {});

      // Connect directly with provided config (no fallback to runtimeConfig)
      await deps.engineAdapter.connect({
        type: body.type,
        ip: body.ip,
        port: body.port,
      });

      fastify.log.info(
        `[Engine] Connected to ${body.type} at ${body.ip}:${body.port}`
      );

      return {
        success: true,
        state: deps.engineAdapter.getState(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error(`[Engine] Connection error: ${errorMessage}`);

      // Handle validation errors
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ZodError"
      ) {
        const zodError = error as z.ZodError;
        return reply.code(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request parameters",
            details: zodError.errors.map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          },
        });
      }

      // Handle EngineError
      if (error instanceof EngineError) {
        const statusCode = mapEngineErrorToStatusCode(error.code);

        return reply.code(statusCode).send({
          success: false,
          error: error.toJSON(),
        });
      }

      // Handle unknown errors
      const unknownErrorMessage =
        error instanceof Error ? error.message : String(error);
      return reply.code(500).send({
        success: false,
        error: {
          code: EngineErrorCode.UNKNOWN_ERROR,
          message: unknownErrorMessage || "Unknown error occurred",
        },
      });
    }
  });

  /**
   * POST /engine/disconnect
   * Disconnect from engine
   */
  fastify.post("/engine/disconnect", async (_request, reply) => {
    try {
      await deps.engineAdapter.disconnect();
      fastify.log.info("[Engine] Disconnected");

      return {
        success: true,
        state: deps.engineAdapter.getState(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Engine] Disconnect error");

      return reply.code(500).send({
        error: "Failed to disconnect",
        message: errorMessage || "Unknown error",
      });
    }
  });

  /**
   * GET /engine/status
   * Get current engine status
   */
  fastify.get("/engine/status", async (_request, reply) => {
    try {
      const state = deps.engineAdapter.getState();
      const connectedSince = deps.engineAdapter.getConnectedSince();
      const lastError = deps.engineAdapter.getLastError();

      return {
        success: true,
        state: {
          ...state,
          connectedSince: connectedSince || undefined,
          lastError: lastError || undefined,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Engine] Status error");

      return reply.code(500).send({
        error: "Failed to get status",
        message: errorMessage || "Unknown error",
      });
    }
  });

  /**
   * GET /engine/macros
   * Get all macros
   */
  fastify.get("/engine/macros", async (_request, reply) => {
    try {
      const macros = deps.engineAdapter.getMacros();
      const status = deps.engineAdapter.getStatus();

      if (status !== "connected") {
        return reply.code(503).send({
          success: false,
          error: "Engine not connected",
          message: `Engine status: ${status}`,
          macros: [],
        });
      }

      return {
        success: true,
        macros,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Engine] Get macros error");

      return reply.code(500).send({
        success: false,
        error: "Failed to get macros",
        message: errorMessage || "Unknown error",
        macros: [],
      });
    }
  });

  /**
   * POST /engine/macros/:id/run
   * Run a macro by ID
   */
  fastify.post("/engine/macros/:id/run", async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const macroId = parseInt(params.id, 10);

      if (isNaN(macroId)) {
        return reply.code(400).send({
          success: false,
          error: "Invalid macro ID",
          message: "Macro ID must be a number",
        });
      }

      await deps.engineAdapter.runMacro(macroId);
      fastify.log.info(`[Engine] Running macro ${macroId}`);

      return {
        success: true,
        macroId,
        state: deps.engineAdapter.getState(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Engine] Run macro error");

      if (errorMessage.includes("not connected")) {
        return reply.code(503).send({
          success: false,
          error: "Engine not connected",
          message: errorMessage,
        });
      }

      return reply.code(500).send({
        success: false,
        error: "Failed to run macro",
        message: errorMessage || "Unknown error",
      });
    }
  });

  /**
   * POST /engine/macros/:id/stop
   * Stop a macro by ID
   */
  fastify.post("/engine/macros/:id/stop", async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const macroId = parseInt(params.id, 10);

      if (isNaN(macroId)) {
        return reply.code(400).send({
          success: false,
          error: "Invalid macro ID",
          message: "Macro ID must be a number",
        });
      }

      await deps.engineAdapter.stopMacro(macroId);
      fastify.log.info(`[Engine] Stopping macro ${macroId}`);

      return {
        success: true,
        macroId,
        state: deps.engineAdapter.getState(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Engine] Stop macro error");

      if (errorMessage.includes("not connected")) {
        return reply.code(503).send({
          success: false,
          error: "Engine not connected",
          message: errorMessage,
        });
      }

      return reply.code(500).send({
        success: false,
        error: "Failed to stop macro",
        message: errorMessage || "Unknown error",
      });
    }
  });

  /**
   * POST /engine/vmix/actions/run
   * Execute a documented vMix action (script start/stop).
   */
  fastify.post("/engine/vmix/actions/run", async (request, reply) => {
    try {
      const body = VmixActionRequestSchema.parse(request.body || {});
      const result = await deps.engineAdapter.runVmixAction(body);

      return {
        success: true,
        action: result,
        state: deps.engineAdapter.getState(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Engine] vMix action error");

      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ZodError"
      ) {
        return reply.code(400).send({
          success: false,
          error: "Invalid vMix action payload",
          message: errorMessage,
        });
      }

      if (errorMessage.includes("not connected")) {
        return reply.code(503).send({
          success: false,
          error: "Engine not connected",
          message: errorMessage,
        });
      }

      return reply.code(500).send({
        success: false,
        error: "Failed to execute vMix action",
        message: errorMessage || "Unknown error",
      });
    }
  });

  // Note: WebSocket is now handled by /ws endpoint with topic subscription
  // This route is kept for backward compatibility but deprecated
}
