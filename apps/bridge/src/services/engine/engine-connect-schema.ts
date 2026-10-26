import { z } from "zod";
import type { EngineConnectConfig } from "./engine-adapter-interface.js";

/**
 * Shared engine-connect payload validation for the HTTP route, the config
 * route and the relay command. One source of truth so the transport rules
 * cannot drift between surfaces:
 *
 * - transport defaults to "network" and requires ip (IPv4) + port
 * - transport "usb" is ATEM-only and needs no ip/port (both are ignored)
 */
const engineConnectFields = {
  type: z.enum(["atem", "tricaster", "vmix", "rodecaster"]),
  transport: z.enum(["network", "usb"]).optional(),
  ip: z.string().trim().ip({ version: "v4" }).optional(),
  port: z.number().int().min(1).max(65535).optional(),
};

function refineEngineConnect(
  value: {
    type: "atem" | "tricaster" | "vmix" | "rodecaster";
    transport?: "network" | "usb";
    ip?: string;
    port?: number;
  },
  ctx: z.RefinementCtx
): void {
  const transport = value.transport ?? "network";
  if (transport === "usb") {
    if (value.type !== "atem") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transport"],
        message: 'transport "usb" is only supported for type "atem"',
      });
    }
    return;
  }
  if (value.ip === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ip"],
      message: 'ip is required for transport "network"',
    });
  }
  if (value.port === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["port"],
      message: 'port is required for transport "network"',
    });
  }
}

/** Non-strict variant (HTTP request bodies). */
export const EngineConnectPayloadSchema = z
  .object(engineConnectFields)
  .superRefine(refineEngineConnect);

/** Strict variant (relay commands reject unknown keys). */
export const EngineConnectPayloadSchemaStrict = z
  .object(engineConnectFields)
  .strict()
  .superRefine(refineEngineConnect);

export type EngineConnectPayloadT = z.infer<typeof EngineConnectPayloadSchema>;

/**
 * Normalize a validated payload into the adapter config. For USB the
 * ip/port sentinels ("", 0) satisfy the config type but are never used or
 * displayed (state carries transport instead).
 */
export function normalizeEngineConnectPayload(
  payload: EngineConnectPayloadT
): EngineConnectConfig {
  const transport = payload.transport ?? "network";
  if (transport === "usb") {
    return { type: payload.type, transport, ip: "", port: 0 };
  }
  // ip/port presence is guaranteed by refineEngineConnect for "network".
  return {
    type: payload.type,
    transport,
    ip: payload.ip as string,
    port: payload.port as number,
  };
}

/**
 * Inverse of normalizeEngineConnectPayload: turn an adapter config back into
 * the wire/on-disk payload shape that EngineConnectPayloadSchema accepts.
 *
 * USB configs carry ip/port sentinels ("", 0) that the schema rejects, so
 * they are dropped entirely; the result for USB has no ip/port keys at all.
 * Network configs keep ip and port. The transport is always explicit.
 *
 * @param config Adapter connection config.
 * @returns Schema-valid payload suitable for persistence.
 */
export function toEngineConnectPayload(
  config: EngineConnectConfig
): EngineConnectPayloadT {
  const transport = config.transport ?? "network";
  if (transport === "usb") {
    return { type: config.type, transport };
  }
  return { type: config.type, transport, ip: config.ip, port: config.port };
}

/**
 * Drop the ip/port sentinels that older bridges persisted for USB
 * connections ({ ..., transport: "usb", ip: "", port: 0 }) so legacy files
 * pass EngineConnectPayloadSchema without a rewrite on disk.
 *
 * Anything that is not an object with transport === "usb" is returned as-is
 * (same reference); the schema decides whether it is valid.
 *
 * @param raw Parsed JSON of unknown shape.
 * @returns A shallow copy without ip/port for USB input, else `raw`.
 */
export function stripLegacyUsbSentinels(raw: unknown): unknown {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as { transport?: unknown }).transport !== "usb"
  ) {
    return raw;
  }
  const { ip: _ip, port: _port, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/**
 * Human-readable connection target for logs (never leaks USB sentinels).
 */
export function describeEngineConnectTarget(
  config: EngineConnectConfig
): string {
  return config.transport === "usb" ? "USB" : `${config.ip}:${config.port}`;
}

export function isSameEngineConnectConfig(
  a: EngineConnectConfig,
  b: EngineConnectConfig
): boolean {
  const aTransport = a.transport ?? "network";
  const bTransport = b.transport ?? "network";
  if (a.type !== b.type || aTransport !== bTransport) {
    return false;
  }
  if (aTransport === "usb") {
    return true;
  }
  return a.ip === b.ip && a.port === b.port;
}
