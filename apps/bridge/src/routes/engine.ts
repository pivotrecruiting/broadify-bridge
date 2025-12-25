import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { engineAdapter } from "../services/engine-adapter.js";

/**
 * Connect request schema
 * All fields are required - no fallback to runtimeConfig
 */
const ConnectRequestSchema = z.object({
  type: z.enum(["atem", "tricaster", "vmix"]),
  ip: z.string().ip({ version: "v4" }),
  port: z.number().int().min(1).max(65535),
});

/**
 * Register engine routes
 *
 * POST /engine/connect - Connect to engine
 * POST /engine/disconnect - Disconnect from engine
 * GET /engine/status - Get engine status
 * GET /engine/macros - Get all macros
 * POST /engine/macros/:id/run - Run macro
 * POST /engine/macros/:id/stop - Stop macro
 * WS /engine/stream - WebSocket stream for real-time updates
 */
export async function registerEngineRoute(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  /**
   * POST /engine/connect
   * Connect to engine (ATEM/Tricaster)
   */
  fastify.post("/engine/connect", async (request, reply) => {
    try {
      const body = ConnectRequestSchema.parse(request.body || {});

      // Connect directly with provided config (no fallback to runtimeConfig)
      await engineAdapter.connect({
        type: body.type,
        ip: body.ip,
        port: body.port,
      });

      fastify.log.info(
        `[Engine] Connected to ${body.type} at ${body.ip}:${body.port}`
      );

      return {
        success: true,
        state: engineAdapter.getState(),
      };
    } catch (error: any) {
      fastify.log.error("[Engine] Connection error:", error);

      if (error.name === "ZodError") {
        return reply.code(400).send({
          error: "Invalid request",
          message: error.errors.map((e: any) => e.message).join(", "),
        });
      }

      return reply.code(500).send({
        error: "Failed to connect",
        message: error.message || "Unknown error",
      });
    }
  });

  /**
   * POST /engine/disconnect
   * Disconnect from engine
   */
  fastify.post("/engine/disconnect", async (_request, reply) => {
    try {
      await engineAdapter.disconnect();
      fastify.log.info("[Engine] Disconnected");

      return {
        success: true,
        state: engineAdapter.getState(),
      };
    } catch (error: any) {
      fastify.log.error("[Engine] Disconnect error:", error);

      return reply.code(500).send({
        error: "Failed to disconnect",
        message: error.message || "Unknown error",
      });
    }
  });

  /**
   * GET /engine/status
   * Get current engine status
   */
  fastify.get("/engine/status", async (_request, reply) => {
    try {
      const state = engineAdapter.getState();
      const connectedSince = engineAdapter.getConnectedSince();
      const lastError = engineAdapter.getLastError();

      return {
        success: true,
        state: {
          ...state,
          connectedSince: connectedSince || undefined,
          lastError: lastError || undefined,
        },
      };
    } catch (error: any) {
      fastify.log.error("[Engine] Status error:", error);

      return reply.code(500).send({
        error: "Failed to get status",
        message: error.message || "Unknown error",
      });
    }
  });

  /**
   * GET /engine/macros
   * Get all macros
   */
  fastify.get("/engine/macros", async (_request, reply) => {
    try {
      const macros = engineAdapter.getMacros();
      const status = engineAdapter.getStatus();

      if (status !== "connected") {
        return reply.code(503).send({
          error: "Engine not connected",
          message: `Engine status: ${status}`,
        });
      }

      return {
        success: true,
        macros,
      };
    } catch (error: any) {
      fastify.log.error("[Engine] Get macros error:", error);

      return reply.code(500).send({
        error: "Failed to get macros",
        message: error.message || "Unknown error",
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
          error: "Invalid macro ID",
          message: "Macro ID must be a number",
        });
      }

      await engineAdapter.runMacro(macroId);
      fastify.log.info(`[Engine] Running macro ${macroId}`);

      return {
        success: true,
        macroId,
        state: engineAdapter.getState(),
      };
    } catch (error: any) {
      fastify.log.error("[Engine] Run macro error:", error);

      if (error.message.includes("not connected")) {
        return reply.code(503).send({
          error: "Engine not connected",
          message: error.message,
        });
      }

      return reply.code(500).send({
        error: "Failed to run macro",
        message: error.message || "Unknown error",
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
          error: "Invalid macro ID",
          message: "Macro ID must be a number",
        });
      }

      await engineAdapter.stopMacro(macroId);
      fastify.log.info(`[Engine] Stopping macro ${macroId}`);

      return {
        success: true,
        macroId,
        state: engineAdapter.getState(),
      };
    } catch (error: any) {
      fastify.log.error("[Engine] Stop macro error:", error);

      if (error.message.includes("not connected")) {
        return reply.code(503).send({
          error: "Engine not connected",
          message: error.message,
        });
      }

      return reply.code(500).send({
        error: "Failed to stop macro",
        message: error.message || "Unknown error",
      });
    }
  });

  // Note: WebSocket is now handled by /ws endpoint with topic subscription
  // This route is kept for backward compatibility but deprecated
}
