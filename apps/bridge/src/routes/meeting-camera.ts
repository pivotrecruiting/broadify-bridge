import type { FastifyInstance, FastifyPluginOptions } from "fastify";

import { meetingHelperManager } from "../services/meeting/meeting-helper-manager.js";
import { enforceLocalOrToken } from "./route-guards.js";

type MeetingCameraRouteDepsT = {
  enforceLocalOrToken: typeof enforceLocalOrToken;
  manager: Pick<typeof meetingHelperManager, "getClient" | "isRunning">;
};

type MeetingCameraRouteOptionsT =
  FastifyPluginOptions & Partial<MeetingCameraRouteDepsT>;

export async function registerMeetingCameraRoute(
  fastify: FastifyInstance,
  options: MeetingCameraRouteOptionsT,
): Promise<void> {
  const deps: MeetingCameraRouteDepsT = {
    enforceLocalOrToken,
    manager: meetingHelperManager,
    ...options,
  };

  fastify.post("/meeting/camera/reopen", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }
    if (!deps.manager.isRunning()) {
      return { ok: true, reopened: false };
    }
    const client = deps.manager.getClient();
    if (!client) {
      return { ok: true, reopened: false };
    }
    const result = await client.cameraReopen();
    return {
      ok: result.ok !== false,
      reopened: result.reopened === true,
    };
  });
}
