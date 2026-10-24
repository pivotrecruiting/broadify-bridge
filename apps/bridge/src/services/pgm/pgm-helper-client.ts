import type { PgmStatusT, VideoInputDescriptorT } from "@broadify/protocol";

import { HelperRequestError, LineRpcClient } from "../helpers/helper-rpc-client.js";
import type { PgmWebrtcOfferT } from "./pgm-command-schemas.js";

export class PgmHelperRequestError extends HelperRequestError {
  constructor(code: string, detail: string) {
    super(code, detail);
    this.name = "PgmHelperRequestError";
  }
}

/** Slow-by-design RPCs: the offer waits for ICE gathering (bounded at 3 s), source select may prompt for camera access. */
const PGM_HELPER_RPC_TIMEOUTS_MS: Record<string, number> = {
  "pgm.viewer.offer": 6_000,
  "pgm.source.select": 130_000,
  "pgm.inputs.list": 130_000,
};

export type PgmInputsListResultT = { inputs: VideoInputDescriptorT[]; camera_permission: string };
export type PgmSessionsResultT = { sessions: Array<{ viewer_id: string; state: string; candidate_type: string; audio: boolean; age_ms: number }> };

/** JSON-RPC client for the native pgm-helper control socket. */
export class PgmHelperClient extends LineRpcClient {
  constructor(socketPath: string, platform?: NodeJS.Platform) {
    super(socketPath, {
      helperName: "PGM helper",
      methodTimeoutsMs: PGM_HELPER_RPC_TIMEOUTS_MS,
      platform,
      createError: (code, detail) => new PgmHelperRequestError(code, detail),
    });
  }

  async ping(): Promise<boolean> {
    const result = await this.rpc<{ pong?: boolean }>("control.ping");
    return result.pong === true;
  }

  shutdown(): Promise<Record<string, unknown>> {
    return this.rpc("control.shutdown");
  }

  status(): Promise<PgmStatusT> {
    return this.rpc<PgmStatusT>("pgm.status");
  }

  inputsList(): Promise<PgmInputsListResultT> {
    return this.rpc<PgmInputsListResultT>("pgm.inputs.list");
  }

  sourceSelect(inputId: string, profile: string): Promise<PgmStatusT> {
    return this.rpc<PgmStatusT>("pgm.source.select", { input_id: inputId, profile });
  }

  sourceClear(): Promise<PgmStatusT> {
    return this.rpc<PgmStatusT>("pgm.source.clear");
  }

  viewerOffer(offer: PgmWebrtcOfferT, profile: string): Promise<{ sdp: string }> {
    return this.rpc<{ sdp: string }>("pgm.viewer.offer", {
      viewer_id: offer.session_id,
      sdp: offer.sdp,
      profile,
      ice_servers: offer.ice_servers.map((server) => ({
        url: server.urls[0],
        username: server.username ?? "",
        credential: server.credential ?? "",
      })),
    });
  }

  viewerClose(sessionId: string): Promise<Record<string, unknown>> {
    return this.rpc("pgm.viewer.close", { viewer_id: sessionId });
  }

  sessionsList(): Promise<PgmSessionsResultT> {
    return this.rpc<PgmSessionsResultT>("pgm.sessions.list");
  }

  perfGet(): Promise<Record<string, unknown>> {
    return this.rpc("pgm.perf.get");
  }
}
