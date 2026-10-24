import type { LiveProgramCapabilitiesT, PgmStatusT } from "@broadify/protocol";
import type { z } from "zod";

import type { RelayCommandResult } from "../command-router.js";
import { parsePgmEnv } from "./pgm-env.js";
import { PgmError, isPgmError } from "./pgm-errors.js";
import {
  PGM_COMMAND_PREFIX,
  PgmEmptyPayloadSchema,
  PgmSourceSelectSchema,
  PgmWebrtcCloseSchema,
  PgmWebrtcOfferSchema,
} from "./pgm-command-schemas.js";

/** `pgm_*` is the live program namespace (mirrors `meeting_` / `conference_`). */
export function isPgmCommand(command: string): boolean {
  return command.startsWith(PGM_COMMAND_PREFIX);
}

export type PgmCommandDepsT = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

const defaultDeps: PgmCommandDepsT = { env: process.env, platform: process.platform };

/**
 * Capability block for `get_status`. Phase 0 scaffolding: the gate decides
 * `supported`; capture, encoder and WebRTC land in the later phases and flip
 * `audio` / `decklink_input` as they ship.
 */
export function getLiveProgramCapabilities(deps: PgmCommandDepsT = defaultDeps): LiveProgramCapabilitiesT {
  const env = parsePgmEnv(deps.env);
  return {
    supported: env.enabled,
    audio: false,
    max_viewers: env.maxViewers,
    decklink_input: false,
  };
}

export function idlePgmStatus(deps: PgmCommandDepsT = defaultDeps): PgmStatusT {
  return {
    enabled: parsePgmEnv(deps.env).enabled,
    state: "idle",
    input: null,
    signal: null,
    encoder: null,
    audio: false,
    viewers: 0,
    last_error: null,
  };
}

function parsePayload<S extends z.ZodTypeAny>(schema: S, payload: unknown, command: string): z.infer<S> {
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ");
    throw new PgmError(command === "pgm_webrtc_offer" ? "pgm_sdp_invalid" : "pgm_not_implemented", `Invalid payload for ${command}: ${detail}`);
  }
  return parsed.data;
}

function failure(error: PgmError): RelayCommandResult {
  return { success: false, error: error.message, errorCode: error.code, data: error.data };
}

/**
 * Dispatches `pgm_*` commands. Phase 0: validates payloads and answers with
 * stable codes (`pgm_disabled` while the gate is off, `pgm_not_implemented`
 * for the parts that land in Phase 1), so the web app can already be wired
 * and tested against the contract.
 */
export async function handlePgmCommand(
  command: string,
  payload: unknown,
  deps: PgmCommandDepsT = defaultDeps,
): Promise<RelayCommandResult> {
  try {
    const env = parsePgmEnv(deps.env);
    switch (command) {
      case "pgm_get_status":
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        return { success: true, data: idlePgmStatus(deps) };
      case "pgm_inputs_list":
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        if (!env.enabled) {
          throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
        }
        throw new PgmError("pgm_not_implemented", "Video input enumeration ships with the PGM helper.");
      case "pgm_source_select":
        parsePayload(PgmSourceSelectSchema, payload, command);
        if (!env.enabled) {
          throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
        }
        throw new PgmError("pgm_not_implemented", "Source selection ships with the PGM helper.");
      case "pgm_source_clear":
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        if (!env.enabled) {
          throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
        }
        throw new PgmError("pgm_not_implemented", "Source selection ships with the PGM helper.");
      case "pgm_session_list":
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        return { success: true, data: { sessions: [], max_viewers: env.maxViewers, active_viewers: 0 } };
      case "pgm_webrtc_offer":
        parsePayload(PgmWebrtcOfferSchema, payload, command);
        if (!env.enabled) {
          throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
        }
        throw new PgmError("pgm_not_implemented", "WebRTC sessions ship with the PGM helper.");
      case "pgm_webrtc_close":
        parsePayload(PgmWebrtcCloseSchema, payload, command);
        if (!env.enabled) {
          throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
        }
        throw new PgmError("pgm_session_not_found", "No live program session with this id.");
      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  } catch (error: unknown) {
    if (isPgmError(error)) {
      return failure(error);
    }
    throw error;
  }
}
