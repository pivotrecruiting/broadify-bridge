import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import {
  meetingMediaService,
  videoMimeForFilename,
} from "../services/meeting/meeting-media-service.js";
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
  "video/mp4",
  "video/webm",
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

  // Streams a stored video asset with Range support so the meeting graphics
  // renderer's <video> element can seek. Local-only like every media route.
  fastify.get(
    "/meeting/media/assets/:assetId/video",
    async (request, reply) => {
      if (!enforceLocalOrToken(request, reply)) {
        return;
      }
      const { assetId } = request.params as { assetId: string };
      try {
        const asset = await meetingMediaService.getAsset(assetId);
        const mime = videoMimeForFilename(asset.filename);
        if (asset.sourceFormat !== "video" || !mime) {
          throw new Error("Asset is not a video.");
        }
        const { size } = await stat(asset.originalPath);
        reply.header("Accept-Ranges", "bytes");
        const rangeHeader = readHeader(request.headers.range);
        const rangeMatch = rangeHeader
          ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
          : null;
        if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
          const start = rangeMatch[1]
            ? Number.parseInt(rangeMatch[1], 10)
            : Math.max(0, size - Number.parseInt(rangeMatch[2], 10));
          const end = rangeMatch[1] && rangeMatch[2]
            ? Math.min(Number.parseInt(rangeMatch[2], 10), size - 1)
            : size - 1;
          if (!Number.isFinite(start) || start >= size || start > end) {
            reply.code(416).header("Content-Range", `bytes */${size}`);
            return { success: false, error: "Requested range not satisfiable." };
          }
          reply
            .code(206)
            .header("Content-Range", `bytes ${start}-${end}/${size}`)
            .header("Content-Length", end - start + 1)
            .type(mime);
          return reply.send(createReadStream(asset.originalPath, { start, end }));
        }
        reply.header("Content-Length", size).type(mime);
        return reply.send(createReadStream(asset.originalPath));
      } catch (error) {
        reply.code(404);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

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
