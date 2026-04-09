import { promises as fs } from "node:fs";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { assetRegistry } from "../services/graphics/asset-registry.js";
import {
  browserInputRuntime,
  type BrowserInputStateSnapshotT,
} from "../services/graphics/browser-input-runtime.js";
import { buildBrowserInputPageHtml } from "../services/graphics/browser-input-page.js";
import {
  enforceLocalOrToken,
  getAuthFailure,
} from "./route-guards.js";

type GraphicsBrowserInputRouteDepsT = {
  browserInputRuntime: Pick<
    typeof browserInputRuntime,
    | "getSnapshot"
    | "subscribe"
    | "markBrowserClientSeen"
    | "registerBrowserClient"
    | "unregisterBrowserClient"
    | "reportError"
  >;
  assetRegistry: Pick<typeof assetRegistry, "getAsset">;
  enforceLocalOrToken: typeof enforceLocalOrToken;
  getAuthFailure: typeof getAuthFailure;
  buildBrowserInputPageHtml: typeof buildBrowserInputPageHtml;
  readFile: typeof fs.readFile;
};

type GraphicsBrowserInputRouteOptionsT = FastifyPluginOptions &
  Partial<GraphicsBrowserInputRouteDepsT>;

/**
 * Register the local browser-input page and transport endpoints.
 *
 * The page is intended for same-machine vMix browser inputs. Remote access is
 * guarded by the existing local-or-token policy.
 */
export async function registerGraphicsBrowserInputRoute(
  fastify: FastifyInstance,
  options: GraphicsBrowserInputRouteOptionsT
): Promise<void> {
  const deps: GraphicsBrowserInputRouteDepsT = {
    browserInputRuntime,
    assetRegistry,
    enforceLocalOrToken,
    getAuthFailure,
    buildBrowserInputPageHtml,
    readFile: fs.readFile,
    ...options,
  };

  fastify.get("/graphics/browser-input", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }

    reply.header("Cache-Control", "no-store");
    reply.type("text/html; charset=utf-8");
    return deps.buildBrowserInputPageHtml();
  });

  fastify.get("/graphics/browser-input/state", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }

    deps.browserInputRuntime.markBrowserClientSeen();
    reply.header("Cache-Control", "no-store");
    return deps.browserInputRuntime.getSnapshot();
  });

  fastify.get<{
    Params: {
      assetId: string;
    };
  }>("/graphics/browser-input/assets/:assetId", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }

    const asset = deps.assetRegistry.getAsset(request.params.assetId);
    if (!asset) {
      deps.browserInputRuntime.reportError(
        "asset_missing",
        `Browser-input asset not found: ${request.params.assetId}`
      );
      reply.code(404);
      return {
        success: false,
        error: "Asset not found",
      };
    }

    const file = await deps.readFile(asset.filePath);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(asset.mime);
    return file;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.get("/graphics/browser-input/ws", { websocket: true } as any, (connection, request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = connection.socket as any;
    const authFailure = deps.getAuthFailure(request);

    if (authFailure) {
      client.close(1008, "Forbidden");
      return;
    }

    const sendSnapshot = (snapshot: BrowserInputStateSnapshotT) => {
      client.send(
        JSON.stringify({
          type: "browser_input.snapshot",
          snapshot,
        })
      );
    };

    deps.browserInputRuntime.registerBrowserClient();
    const unsubscribe = deps.browserInputRuntime.subscribe((snapshot) => {
      try {
        sendSnapshot(snapshot);
      } catch {
        unsubscribe();
      }
    });

    try {
      sendSnapshot(deps.browserInputRuntime.getSnapshot());
    } catch {
      unsubscribe();
      client.close(1011, "Snapshot failed");
      return;
    }

    client.on("close", () => {
      unsubscribe();
      deps.browserInputRuntime.unregisterBrowserClient();
    });

    client.on("error", () => {
      unsubscribe();
      deps.browserInputRuntime.unregisterBrowserClient();
    });
  });
}
