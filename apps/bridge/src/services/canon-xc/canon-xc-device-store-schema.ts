import { z } from "zod";

/**
 * Persistence schema for one device in `studio-adapters/canon-xc-devices.json`.
 *
 * This is the on-disk contract, intentionally separate from the relay input
 * schema in `relay-command-schemas.ts` (input validation != persistence). It is
 * not `.strict()` so extra fields written by older builds are tolerated, and
 * the fields `normalizeDevice` has always defaulted keep those defaults here.
 */
export const CanonXCStoredDeviceSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "https"]).default("http"),
  type: z.enum(["camera", "rc-ip1000"]).default("camera"),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
  cameraNo: z.number().int().nullable().default(null),
  enabled: z.boolean().default(true),
});

export type CanonXCStoredDeviceT = z.infer<typeof CanonXCStoredDeviceSchema>;

/** Shape of the whole device store file. */
export const CanonDevicesFileSchema = z.object({
  devices: z.array(CanonXCStoredDeviceSchema).default([]),
  updatedAt: z.string().optional(),
});

export type CanonDevicesFileT = z.infer<typeof CanonDevicesFileSchema>;
