import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBridgeContext } from "../bridge-context.js";

const CANON_XC_PATH_PREFIX = "/-wvhttp-01-/";
const CANON_DEVICES_FILE = "canon-xc-devices.json";

export type CanonXCDeviceTypeT = "camera" | "rc-ip1000";
export type CanonXCProtocolT = "http" | "https";

export type CanonXCDeviceT = {
  deviceId: string;
  name: string;
  host: string;
  port: number;
  protocol: CanonXCProtocolT;
  type: CanonXCDeviceTypeT;
  username: string | null;
  password: string | null;
  cameraNo: number | null;
  enabled: boolean;
};

export type CanonXCPublicDeviceT = Omit<CanonXCDeviceT, "password"> & {
  id: string;
};

export type CanonXCDeviceInputT = {
  deviceId?: string;
  name: string;
  host: string;
  port?: number;
  protocol?: CanonXCProtocolT;
  type?: CanonXCDeviceTypeT;
  username?: string | null;
  password?: string | null;
  cameraNo?: number | null;
  enabled?: boolean;
};

export type CanonPresetRecallOptionsT = {
  ptztime?: number;
  ptzspeed?: number;
  useSavedSpeed?: boolean;
  freeze?: boolean;
};

export type CanonXCPresetT = {
  id: string;
  deviceId: string;
  preset: number;
  presetNo: number;
  label: string;
  name: string;
  enabled: boolean;
  contentEnabled: boolean;
  ptzEnabled: boolean;
  focusEnabled: boolean;
  expEnabled: boolean;
  wbEnabled: boolean;
  thumbnailId: string | null;
  content: {
    ptz: boolean;
    focus: boolean;
    exp: boolean;
    wb: boolean;
    is: boolean;
    cp: boolean;
    lenscorrect: boolean;
  };
};

export type CanonXCStatusT = {
  connected: boolean;
  host: string;
  model: string | null;
  firmware: string | null;
  presetCount: number;
  presetsReady: boolean;
  lastError: string | null;
};

export type CanonXCDiagnosticCodeT =
  | "authentication"
  | "network"
  | "timeout"
  | "tls"
  | "camera_response";

export type CanonXCDiagnosticT = {
  code: CanonXCDiagnosticCodeT;
  hint: string;
};

export type CanonXCResponseT = {
  ok: boolean;
  message: string;
  device: CanonXCPublicDeviceT | null;
  status: CanonXCStatusT | null;
  presets: CanonXCPresetT[];
  result: Record<string, unknown>;
  rawError: string | null;
  diagnostic: CanonXCDiagnosticT | null;
};

type CanonDevicesFileT = {
  devices?: CanonXCDeviceT[];
  updatedAt?: string;
};

type CanonHttpResponseT = {
  ok: boolean;
  text: string;
  statusCode: number;
  headers: Headers;
  error: string | null;
};

/**
 * Parses Canon XC plain-text key/value responses.
 */
export function parseCanonInfo(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = [":=", "==", "="].find((item) => line.includes(item));
    if (!separator) {
      continue;
    }

    const [rawKey, ...rawValueParts] = line.split(separator);
    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    parsed[key] = rawValueParts.join(separator).trim();
  }
  return parsed;
}

const isEnabled = (value: string | undefined, fallback = false): boolean => {
  if (value == null) {
    return fallback;
  }

  return ["enabled", "enable", "on", "1", "true", "yes", "supported"].includes(
    value.trim().toLowerCase(),
  );
};

/**
 * Builds UI-ready Canon presets from XC info.cgi preset fields.
 */
export function presetsFromCanonInfo(
  deviceId: string,
  info: Record<string, string>,
): CanonXCPresetT[] {
  const parsedCount = Number.parseInt(info["p.count"] ?? "0", 10);
  const maxPreset = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 100;
  const presets: CanonXCPresetT[] = [];

  for (let presetNo = 1; presetNo <= maxPreset; presetNo += 1) {
    const prefix = `p.${presetNo}`;
    const name = info[`${prefix}.name.utf8`] ?? info[`${prefix}.name`] ?? "";
    const content = info[`${prefix}.content`];
    const ptz = info[`${prefix}.content.ptz`];
    const focus = info[`${prefix}.content.focus`];
    const exp = info[`${prefix}.content.exp`];
    const wb = info[`${prefix}.content.wb`];
    const imageStabilizer = info[`${prefix}.content.is`];
    const cp = info[`${prefix}.content.cp`];
    const lenscorrect = info[`${prefix}.content.lenscorrect`];
    const thumbnailId = info[`${prefix}.thumbnail.id`] ?? null;
    const hasContentFields = [
      content,
      ptz,
      focus,
      exp,
      wb,
      imageStabilizer,
      cp,
      lenscorrect,
      thumbnailId,
    ].some((value) => value != null);

    if (!name && !hasContentFields) {
      continue;
    }

    const contentEnabled = isEnabled(content, Boolean(name || hasContentFields));
    if (!contentEnabled && !name) {
      continue;
    }

    presets.push({
      id: `${deviceId}:preset:${presetNo}`,
      deviceId,
      preset: presetNo,
      presetNo,
      label: name || `Preset ${presetNo}`,
      name: name || `Preset ${presetNo}`,
      enabled: contentEnabled,
      contentEnabled,
      ptzEnabled: isEnabled(ptz, contentEnabled),
      focusEnabled: isEnabled(focus, contentEnabled),
      expEnabled: isEnabled(exp, contentEnabled),
      wbEnabled: isEnabled(wb, contentEnabled),
      thumbnailId,
      content: {
        ptz: isEnabled(ptz, contentEnabled),
        focus: isEnabled(focus, contentEnabled),
        exp: isEnabled(exp, contentEnabled),
        wb: isEnabled(wb, contentEnabled),
        is: isEnabled(imageStabilizer),
        cp: isEnabled(cp),
        lenscorrect: isEnabled(lenscorrect),
      },
    });
  }

  return presets;
}

const normalizeProtocol = (protocol: unknown): CanonXCProtocolT =>
  protocol === "https" ? "https" : "http";

const normalizeDeviceType = (type: unknown): CanonXCDeviceTypeT =>
  type === "rc-ip1000" ? "rc-ip1000" : "camera";

const normalizeOptionalText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeDevice = (
  input: CanonXCDeviceInputT,
  fallbackDeviceId: string,
): CanonXCDeviceT => {
  const protocol = normalizeProtocol(input.protocol);
  const type = normalizeDeviceType(input.type);
  const port =
    input.port ??
    (type === "rc-ip1000" ? (protocol === "https" ? 50443 : 50080) : protocol === "https" ? 443 : 80);

  return {
    deviceId: normalizeOptionalText(input.deviceId) ?? fallbackDeviceId,
    name: normalizeOptionalText(input.name) ?? "Canon PTZ 1",
    host: normalizeOptionalText(input.host) ?? "",
    port,
    protocol,
    type,
    username: normalizeOptionalText(input.username),
    password: typeof input.password === "string" && input.password.length > 0 ? input.password : null,
    cameraNo: typeof input.cameraNo === "number" ? input.cameraNo : null,
    enabled: input.enabled ?? true,
  };
};

const publicDevice = (device: CanonXCDeviceT): CanonXCPublicDeviceT => ({
  id: device.deviceId,
  deviceId: device.deviceId,
  name: device.name,
  host: device.host,
  port: device.port,
  protocol: device.protocol,
  type: device.type,
  username: device.username,
  cameraNo: device.cameraNo,
  enabled: device.enabled,
});

/**
 * Provides Canon XC device persistence, preset discovery, and preset recall.
 */
export class CanonXCService {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 4_000) {
    this.timeoutMs = timeoutMs;
  }

  async listDevices(): Promise<{ devices: CanonXCPublicDeviceT[] }> {
    const devices = await this.loadDevices();
    return { devices: devices.map(publicDevice) };
  }

  async saveDevice(input: CanonXCDeviceInputT): Promise<CanonXCPublicDeviceT> {
    const devices = await this.loadDevices();
    const fallbackDeviceId = this.nextDeviceId(devices);
    const nextDevice = normalizeDevice(input, fallbackDeviceId);
    this.validateDevice(nextDevice);

    const existing = devices.find((device) => device.deviceId === nextDevice.deviceId);
    if (existing && nextDevice.password == null) {
      nextDevice.password = existing.password;
    }

    await this.saveDevices([
      ...devices.filter((device) => device.deviceId !== nextDevice.deviceId),
      nextDevice,
    ]);
    return publicDevice(nextDevice);
  }

  /**
   * Tests a Canon XC connection without writing the supplied configuration to disk.
   */
  async testConnection(input: CanonXCDeviceInputT): Promise<CanonXCResponseT> {
    const devices = await this.loadDevices();
    const fallbackDeviceId = input.deviceId ?? "canon-test";
    const nextDevice = normalizeDevice(input, fallbackDeviceId);
    const existing = devices.find((device) => device.deviceId === nextDevice.deviceId);
    if (existing && nextDevice.password == null) {
      nextDevice.password = existing.password;
    }
    this.validateDevice(nextDevice);

    return this.loadPresetsForDevice(nextDevice, "Canon XC connection ok.");
  }

  async deleteDevice(deviceId: string): Promise<{ ok: true; message: string }> {
    const devices = await this.loadDevices();
    const remaining = devices.filter((device) => device.deviceId !== deviceId);
    if (remaining.length === devices.length) {
      throw new Error(`Canon XC device '${deviceId}' was not found.`);
    }

    await this.saveDevices(remaining);
    return { ok: true, message: `Canon XC device '${deviceId}' deleted.` };
  }

  async testDevice(deviceId: string): Promise<CanonXCResponseT> {
    return this.loadPresets(deviceId, "Canon XC connection ok.");
  }

  async listPresets(deviceId: string): Promise<CanonXCResponseT> {
    return this.loadPresets(deviceId);
  }

  async recallPreset(
    deviceId: string,
    preset: number,
    options?: CanonPresetRecallOptionsT,
  ): Promise<CanonXCResponseT> {
    if (!Number.isInteger(preset) || preset < 1 || preset > 100) {
      throw new Error("Canon XC preset must be between 1 and 100.");
    }

    const device = await this.getDevice(deviceId);
    const params: Record<string, string | number> = { p: preset };
    if (device.type === "rc-ip1000" && device.cameraNo != null) {
      params["camno.target"] = device.cameraNo;
    }
    if (options?.ptztime != null) {
      params["p.ptztime"] = options.ptztime;
    } else if (options?.useSavedSpeed) {
      params["p.ptzspeed.saved"] = "on";
    } else if (options?.ptzspeed != null) {
      params["p.ptzspeed"] = options.ptzspeed;
    }
    if (options?.freeze) {
      params["p.freeze"] = "on";
    }

    const response = await this.request(device, "control.cgi", params);
    if (!response.ok) {
      return this.errorResponse(device, `Canon XC preset ${preset} recall failed.`, response);
    }

    return {
      ok: true,
      message: `Canon XC preset ${preset} recalled.`,
      device: publicDevice(device),
      status: null,
      presets: [],
      result: {
        preset,
        presetNo: preset,
        response: parseCanonInfo(response.text),
        statusCode: response.statusCode,
        requestUrl: this.buildUrl(device, "control.cgi", params),
        livescopeStatus: response.headers.get("livescope-status"),
      },
      rawError: null,
      diagnostic: null,
    };
  }

  private async loadPresets(deviceId: string, successMessage?: string): Promise<CanonXCResponseT> {
    const device = await this.getDevice(deviceId);
    return this.loadPresetsForDevice(device, successMessage);
  }

  private async loadPresetsForDevice(
    device: CanonXCDeviceT,
    successMessage?: string,
  ): Promise<CanonXCResponseT> {
    const response = await this.request(device, "info.cgi", { item: "p" });
    if (!response.ok) {
      return this.errorResponse(device, "Could not load Canon XC presets.", response);
    }

    const info = parseCanonInfo(response.text);
    const presets = presetsFromCanonInfo(device.deviceId, info);
    return {
      ok: true,
      message: successMessage ?? `Loaded ${presets.length} Canon XC presets.`,
      device: publicDevice(device),
      status: this.statusFromInfo(device, info, presets, true),
      presets,
      result: { info },
      rawError: null,
      diagnostic: null,
    };
  }

  private validateDevice(device: CanonXCDeviceT): void {
    if (!device.host) {
      throw new Error("Canon XC host is required.");
    }
    if (!Number.isInteger(device.port) || device.port < 1 || device.port > 65535) {
      throw new Error("Canon XC port must be between 1 and 65535.");
    }
    if (device.type === "rc-ip1000" && device.cameraNo != null && device.cameraNo < 1) {
      throw new Error("Canon XC camera number must be greater than 0.");
    }
  }

  private statusFromInfo(
    device: CanonXCDeviceT,
    info: Record<string, string>,
    presets: CanonXCPresetT[],
    connected: boolean,
  ): CanonXCStatusT {
    const presetCount = Number.parseInt(info["p.count"] ?? `${presets.length}`, 10);
    return {
      connected,
      host: device.host,
      model: info["s.hardware"] ?? info["s.model"] ?? info["s.product"] ?? null,
      firmware: info["s.firmware"] ?? null,
      presetCount: Number.isFinite(presetCount) ? presetCount : presets.length,
      presetsReady: presets.length > 0,
      lastError: null,
    };
  }

  private errorResponse(
    device: CanonXCDeviceT,
    message: string,
    response: CanonHttpResponseT,
  ): CanonXCResponseT {
    const diagnostic = this.diagnosticFromResponse(response);
    return {
      ok: false,
      message,
      device: publicDevice(device),
      status: {
        connected: false,
        host: device.host,
        model: null,
        firmware: null,
        presetCount: 0,
        presetsReady: false,
        lastError: response.error,
      },
      presets: [],
      result: {
        statusCode: response.statusCode,
        response: response.text.slice(0, 1000),
      },
      rawError: response.error,
      diagnostic,
    };
  }

  private diagnosticFromResponse(response: CanonHttpResponseT): CanonXCDiagnosticT {
    const error = (response.error ?? "").toLowerCase();

    if (response.statusCode === 401 || response.statusCode === 403) {
      return {
        code: "authentication",
        hint: "Check the Canon username, password, and assigned access rights.",
      };
    }

    if (error.includes("timed out")) {
      return {
        code: "timeout",
        hint: "Check the camera address, port, firewall, and local network access.",
      };
    }

    if (
      error.includes("certificate") ||
      error.includes("tls") ||
      error.includes("ssl")
    ) {
      return {
        code: "tls",
        hint: "Check the selected HTTPS setting and the camera certificate.",
      };
    }

    if (response.statusCode === 0) {
      return {
        code: "network",
        hint: "Check the camera address, port, firewall, and macOS Local Network permission for Broadify Bridge.",
      };
    }

    return {
      code: "camera_response",
      hint: "The camera rejected the Canon XC request. Check the selected protocol and camera settings.",
    };
  }

  private async request(
    device: CanonXCDeviceT,
    command: string,
    params?: Record<string, string | number>,
  ): Promise<CanonHttpResponseT> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers();

    if (device.username && device.password) {
      const token = Buffer.from(`${device.username}:${device.password}`, "utf8").toString("base64");
      headers.set("Authorization", `Basic ${token}`);
    }

    try {
      const response = await fetch(this.buildUrl(device, command, params), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      const livescopeStatus = response.headers.get("livescope-status");
      const livescopeOk =
        !livescopeStatus || ["0", "0 OK", "OK"].includes(livescopeStatus.trim());

      const result = {
        ok: response.ok && livescopeOk,
        text,
        statusCode: response.status,
        headers: response.headers,
        error: response.ok
          ? livescopeOk
            ? null
            : `Canon Livescope status ${livescopeStatus}.`
            : `HTTP ${response.status}: ${response.statusText}`,
      };
      this.logRequest(device, command, result, startedAt);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        text: "",
        statusCode: 0,
        headers: new Headers(),
        error:
          error instanceof Error && error.name === "AbortError"
            ? "Canon XC request timed out."
            : error instanceof Error
              ? error.message
              : String(error),
      };
      this.logRequest(device, command, result, startedAt);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private logRequest(
    device: CanonXCDeviceT,
    command: string,
    response: CanonHttpResponseT,
    startedAt: number,
  ): void {
    const logger = getBridgeContext().logger;
    const details = {
      component: "canon-xc",
      command,
      host: device.host,
      port: device.port,
      protocol: device.protocol,
      statusCode: response.statusCode,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      error: this.redactLogError(response.error),
      message: response.ok
        ? "[CanonXC] Request completed"
        : "[CanonXC] Request failed",
    };
    const logMessage = JSON.stringify(details);

    if (response.ok) {
      logger?.info?.(logMessage);
      return;
    }
    logger?.warn?.(logMessage);
  }

  private redactLogError(error: string | null): string | null {
    if (!error) {
      return null;
    }

    return error.replace(
      /\b(password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    );
  }

  private buildUrl(
    device: CanonXCDeviceT,
    command: string,
    params?: Record<string, string | number>,
  ): string {
    const url = new URL(`${device.protocol}://${device.host}:${device.port}${CANON_XC_PATH_PREFIX}${command}`);
    Object.entries(params ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  private async getDevice(deviceId: string): Promise<CanonXCDeviceT> {
    const device = (await this.loadDevices()).find((item) => item.deviceId === deviceId);
    if (!device) {
      throw new Error(`Canon XC device '${deviceId}' was not found.`);
    }
    return device;
  }

  private async loadDevices(): Promise<CanonXCDeviceT[]> {
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as CanonDevicesFileT;
      return Array.isArray(parsed.devices) ? parsed.devices.map((device) => normalizeDevice(device, device.deviceId)) : [];
    } catch {
      return [];
    }
  }

  private async saveDevices(devices: CanonXCDeviceT[]): Promise<void> {
    const filePath = this.filePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ devices, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }

  private filePath(): string {
    return path.join(getBridgeContext().userDataDir, "studio-adapters", CANON_DEVICES_FILE);
  }

  private nextDeviceId(devices: CanonXCDeviceT[]): string {
    const used = new Set(devices.map((device) => device.deviceId));
    let index = 1;
    while (used.has(`canon-${index}`)) {
      index += 1;
    }
    return `canon-${index}`;
  }
}

export const canonXCService = new CanonXCService();
