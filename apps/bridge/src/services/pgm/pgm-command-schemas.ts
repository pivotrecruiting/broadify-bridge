import { z } from "zod";

/**
 * Zod schemas for the `pgm_*` relay commands (live program preview).
 * Strict by default: the web app never sends unknown keys, and the command
 * route injects `viewer_user_id` / `ice_servers` server-side, so a payload
 * carrying them from the browser is rejected there, not here.
 */
export const PGM_COMMAND_PREFIX = "pgm_";

export const PGM_SDP_MAX_BYTES = 32_768;
export const PGM_SDP_MAX_LINES = 400;

export const PgmEmptyPayloadSchema = z.object({}).strict();

export const PgmSessionIdSchema = z.string().uuid();

export const PgmProfileSchema = z.enum(["auto", "lan", "remote"]);

export const PgmSourceSelectSchema = z
  .object({
    input_id: z.string().trim().min(1).max(256),
    profile: PgmProfileSchema.optional(),
  })
  .strict();

export const PgmIceServerSchema = z
  .object({
    urls: z.array(z.string().trim().min(1).max(256)).min(1).max(4),
    username: z.string().max(256).optional(),
    credential: z.string().max(256).optional(),
  })
  .strict();

/**
 * Structural checks on a recvonly offer. Deliberately not a full SDP parser:
 * libdatachannel validates the rest when the answer is built.
 */
export function isSaneRecvonlyOffer(sdp: string): boolean {
  if (sdp.length === 0 || sdp.length > PGM_SDP_MAX_BYTES) {
    return false;
  }
  const lines = sdp.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > PGM_SDP_MAX_LINES) {
    return false;
  }
  if (!lines[0]?.startsWith("v=0")) {
    return false;
  }
  const videoSections = lines.filter((line) => line.startsWith("m=video ")).length;
  const audioSections = lines.filter((line) => line.startsWith("m=audio ")).length;
  const otherSections = lines.filter(
    (line) => line.startsWith("m=") && !line.startsWith("m=video ") && !line.startsWith("m=audio "),
  ).length;
  if (videoSections !== 1 || audioSections > 1 || otherSections > 0) {
    return false;
  }
  if (lines.some((line) => line === "a=ice-lite")) {
    return false;
  }
  if (lines.some((line) => line === "a=sendrecv" || line === "a=sendonly")) {
    return false;
  }
  return true;
}

export const PgmWebrtcOfferSchema = z
  .object({
    session_id: PgmSessionIdSchema,
    sdp: z.string().refine(isSaneRecvonlyOffer, { message: "Offer must be a single recvonly video (+ optional audio) SDP." }),
    viewer_user_id: z.string().uuid(),
    ice_servers: z.array(PgmIceServerSchema).max(4),
    label: z.string().trim().max(64).optional(),
  })
  .strict();

export const PgmWebrtcCloseSchema = z
  .object({
    session_id: PgmSessionIdSchema,
    viewer_user_id: z.string().uuid(),
  })
  .strict();

export type PgmSourceSelectT = z.infer<typeof PgmSourceSelectSchema>;
export type PgmWebrtcOfferT = z.infer<typeof PgmWebrtcOfferSchema>;
export type PgmWebrtcCloseT = z.infer<typeof PgmWebrtcCloseSchema>;
