import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import { meetingMediaService } from "../services/meeting/meeting-media-service.js";
import {
  BACKGROUND_IMAGE_MAX_BYTES,
  storeBackgroundImage,
} from "../services/meeting/background-image-store.js";
import { enforceLocalOrToken } from "./route-guards.js";

const MEETING_MEDIA_BODY_LIMIT_BYTES = 500 * 1024 * 1024;
const RAW_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const readHeader = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
};

const decodeFilenameHeader = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Registers local-only meeting media upload and asset routes.
 */
export async function registerMeetingMediaRoute(
  fastify: FastifyInstance,
): Promise<void> {
  for (const contentType of [...RAW_CONTENT_TYPES, "image/png", "image/jpeg", "image/webp"]) {
    fastify.addContentTypeParser(
      contentType,
      { bodyLimit: MEETING_MEDIA_BODY_LIMIT_BYTES },
      (_request, payload, done) => done(null, payload),
    );
  }

  fastify.get("/meeting/media/rendering-status", async (request, reply) => {
    if (!enforceLocalOrToken(request, reply)) {
      return;
    }
    return meetingMediaService.renderingStatus();
  });

  fastify.post(
    "/meeting/media/assets",
    { bodyLimit: MEETING_MEDIA_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (!enforceLocalOrToken(request, reply)) {
        return;
      }
      if (!request.body || typeof (request.body as Readable).pipe !== "function") {
        reply.code(400);
        return {
          success: false,
          error: "Expected raw PPTX or PDF request body.",
        };
      }
      const filename = decodeFilenameHeader(
        readHeader(request.headers["x-broadify-filename"]) ?? "presentation",
      );
      try {
        return await meetingMediaService.saveUpload(filename, request.body as Readable);
      } catch (error) {
        reply.code(400);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // Company background images: stored locally, the native compositor loads
  // them by absolute path (keyer.configure background_image_path).
  fastify.post(
    "/meeting/background-image",
    { bodyLimit: BACKGROUND_IMAGE_MAX_BYTES },
    async (request, reply) => {
      if (!enforceLocalOrToken(request, reply)) {
        return;
      }
      const stream = request.body as Readable | undefined;
      if (!stream || typeof stream.pipe !== "function") {
        reply.code(400);
        return { success: false, error: "Expected raw image request body." };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      try {
        const filePath = await storeBackgroundImage(
          Buffer.concat(chunks),
          readHeader(request.headers["content-type"]) ?? "",
        );
        return { success: true, path: filePath };
      } catch (error) {
        reply.code(400);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  fastify.get("/meeting/media/assets", async (request, reply) => {
    if (!enforceLocalOrToken(request, reply)) {
      return;
    }
    return meetingMediaService.listAssets();
  });

  fastify.get("/meeting/media/assets/:assetId", async (request, reply) => {
    if (!enforceLocalOrToken(request, reply)) {
      return;
    }
    const { assetId } = request.params as { assetId: string };
    try {
      return await meetingMediaService.getAsset(assetId);
    } catch (error) {
      reply.code(404);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  fastify.get(
    "/meeting/media/assets/:assetId/pages/:page/image.png",
    async (request, reply) => {
      if (!enforceLocalOrToken(request, reply)) {
        return;
      }
      const { assetId, page } = request.params as {
        assetId: string;
        page: string;
      };
      try {
        const asset = await meetingMediaService.getAsset(assetId);
        const imagePath = meetingMediaService.getPageImagePath(
          asset,
          Number.parseInt(page, 10) || 0,
        );
        if (!imagePath) {
          throw new Error("Rendered page image was not found.");
        }
        return reply.type("image/png").send(createReadStream(imagePath));
      } catch (error) {
        reply.code(404);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
