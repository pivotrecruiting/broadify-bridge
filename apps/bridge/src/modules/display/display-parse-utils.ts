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
 * Normalize Windows instance key (trim, lowercase, strip trailing _N).
 */
export const normalizeWindowsInstanceKey = (value: string): string =>
  value.trim().toLowerCase().replace(/_\d+$/, "");

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
 * Parse a CSV line handling quoted fields.
 */
export const parseCsvLine = (line: string): string[] => {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map((value) => value.trim());
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

/**
 * Parse CSV stdout into array of row objects.
 *
 * @param stdout Raw CSV text (header row + data rows).
 * @returns Array of row objects keyed by header names.
 */
export const parseCsvRows = (stdout: string): Record<string, string>[] => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  if (headers.length === 0) {
    return [];
  }

  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    if (values.length === 0) {
      continue;
    }
    const row: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = values[index] ?? "";
    }
    rows.push(row);
  }

  return rows;
};

/**
 * Parse Windows PnP device ID to extract vendor and product IDs.
 */
export const parseWindowsMonitorPnpId = (
  pnpDeviceId?: string
): { vendorId?: string; productId?: string } => {
  if (!pnpDeviceId) {
    return {};
  }
  const match = pnpDeviceId.match(/^DISPLAY\\([A-Z0-9]{3})([A-Z0-9]{4})/i);
  if (!match) {
    return {};
  }
  return {
    vendorId: match[1],
    productId: match[2],
  };
};
