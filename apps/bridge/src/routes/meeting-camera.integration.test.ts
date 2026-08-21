import Fastify from "fastify";

import { registerMeetingCameraRoute } from "./meeting-camera.js";

describe("registerMeetingCameraRoute integration", () => {
  it("returns reopened false when the meeting engine is not running", async () => {
    const app = Fastify();
    const cameraReopen = jest.fn();
    await app.register(registerMeetingCameraRoute, {
      enforceLocalOrToken: () => true,
      manager: {
        getClient: () => ({ cameraReopen }),
        isRunning: () => false,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/meeting/camera/reopen",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, reopened: false });
    expect(cameraReopen).not.toHaveBeenCalled();
  });

  it("calls cameraReopen when the meeting engine is running", async () => {
    const app = Fastify();
    const cameraReopen = jest.fn().mockResolvedValue({ ok: true, reopened: true });
    await app.register(registerMeetingCameraRoute, {
      enforceLocalOrToken: () => true,
      manager: {
        getClient: () => ({ cameraReopen }),
        isRunning: () => true,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/meeting/camera/reopen",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, reopened: true });
    expect(cameraReopen).toHaveBeenCalledTimes(1);
  });

  it("does not run when local/token auth fails", async () => {
    const app = Fastify();
    const cameraReopen = jest.fn();
    await app.register(registerMeetingCameraRoute, {
      enforceLocalOrToken: (_request, reply) => {
        reply.code(403).send({ error: "forbidden" });
        return false;
      },
      manager: {
        getClient: () => ({ cameraReopen }),
        isRunning: () => true,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/meeting/camera/reopen",
    });

    expect(response.statusCode).toBe(403);
    expect(cameraReopen).not.toHaveBeenCalled();
  });
});
