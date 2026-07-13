import type { PortDescriptorT } from "@broadify/protocol";

/**
 * Stabilize IDs by stripping punctuation and normalizing to lowercase.
 */
export const sanitizeIdPart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Convert system_profiler connection labels into protocol port types.
 */
export const normalizeConnectionType = (
  value?: string
): PortDescriptorT["type"] | null => {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower.includes("hdmi")) {
    return "hdmi";
  }
  if (lower.includes("displayport")) {
    return "displayport";
  }
  if (lower.includes("thunderbolt")) {
    return "thunderbolt";
  }
  if (lower.includes("usb-c") || lower.includes("usb c")) {
    return "thunderbolt";
  }
  return null;
};

/**
 * Map Windows video output technology enum to protocol port type.
 */
export const normalizeWindowsConnectionType = (
  value?: number
): PortDescriptorT["type"] | null => {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value === 5 || value === 6) {
    return "hdmi";
  }
  if (
    value === 10 ||
    value === 11 ||
    value === 12 ||
    value === 13 ||
    value === 14 ||
    value === 18
  ) {
    return "displayport";
  }
  return null;
};

/**
 * Best-effort resolution parsing ("3840 x 2160").
 */
export const parseResolution = (
  value?: string
): { width: number; height: number } | undefined => {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return { width, height };
};

/**
 * Best-effort refresh parsing ("59.94 Hz").
 */
export const parseRefreshHz = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d+(?:\.\d+)?)\s*hz/i);
  if (!match) {
    return undefined;
  }
  const hz = Number(match[1]);
  return Number.isFinite(hz) ? hz : undefined;
};
