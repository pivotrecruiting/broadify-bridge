import type { LiveProgramCapabilitiesT, PgmStatusT } from "@broadify/protocol";
import type { z } from "zod";

import type { RelayCommandResult } from "../command-router.js";
import { parsePgmEnv } from "./pgm-env.js";
import { PgmError, isPgmError } from "./pgm-errors.js";
import { pgmHelperManager, type PgmHelperManager } from "./pgm-helper-manager.js";
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
  manager: () => Pick<PgmHelperManager, "getStatus" | "getSessions" | "listInputs" | "selectSource" | "clearSource" | "offer" | "close">;
};

const defaultDeps: PgmCommandDepsT = { env: process.env, platform: process.platform, manager: () => pgmHelperManager };

/**
 * Capability block for `get_status`. The gate decides `supported`; audio and
 * DeckLink flip as the phases ship (macOS UVC + audio in phase 1).
 */
export function getLiveProgramCapabilities(deps: Pick<PgmCommandDepsT, "env" | "platform"> = defaultDeps): LiveProgramCapabilitiesT {
  const env = parsePgmEnv(deps.env);
  const supported = env.enabled && deps.platform === "darwin";
  return { supported, audio: supported, max_viewers: env.maxViewers, decklink_input: false };
}

export function idlePgmStatus(deps: Pick<PgmCommandDepsT, "env"> = defaultDeps): PgmStatusT {
  return { enabled: parsePgmEnv(deps.env).enabled, state: "idle", input: null, signal: null, encoder: null, audio: false, viewers: 0, last_error: null };
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

function assertSupported(deps: PgmCommandDepsT): void {
  const env = parsePgmEnv(deps.env);
  if (!env.enabled) {
    throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
  }
  if (deps.platform !== "darwin") {
    throw new PgmError("pgm_unsupported_bridge", "Live program preview ships for macOS bridges first; Windows follows.");
  }
}

/** Dispatches `pgm_*` commands to the helper manager; every failure carries a stable code. */
export async function handlePgmCommand(command: string, payload: unknown, deps: PgmCommandDepsT = defaultDeps): Promise<RelayCommandResult> {
  try {
    switch (command) {
      case "pgm_get_status": {
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        const status = parsePgmEnv(deps.env).enabled ? deps.manager().getStatus() : idlePgmStatus(deps);
        return { success: true, data: status };
      }
      case "pgm_inputs_list": {
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        assertSupported(deps);
        return { success: true, data: await deps.manager().listInputs() };
      }
      case "pgm_source_select": {
        const input = parsePayload(PgmSourceSelectSchema, payload, command);
        assertSupported(deps);
        return { success: true, data: await deps.manager().selectSource(input.input_id, input.profile ?? "auto") };
      }
      case "pgm_source_clear": {
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        assertSupported(deps);
        return { success: true, data: await deps.manager().clearSource() };
      }
      case "pgm_session_list": {
        parsePayload(PgmEmptyPayloadSchema, payload, command);
        return { success: true, data: deps.manager().getSessions() };
      }
      case "pgm_webrtc_offer": {
        const offer = parsePayload(PgmWebrtcOfferSchema, payload, command);
        assertSupported(deps);
        const answer = await deps.manager().offer(offer);
        return {
          success: true,
          data: {
            session_id: offer.session_id,
            sdp: answer.sdp,
            expires_at: Date.now() + 2 * 60 * 60 * 1000,
            max_viewers: answer.max_viewers,
            active_viewers: answer.active_viewers,
            stream: { codec: "h264", audio: deps.manager().getStatus().audio },
          },
        };
      }
      case "pgm_webrtc_close": {
        const close = parsePayload(PgmWebrtcCloseSchema, payload, command);
        assertSupported(deps);
        await deps.manager().close(close.session_id, close.viewer_user_id);
        return { success: true, data: { closed: true } };
      }
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
