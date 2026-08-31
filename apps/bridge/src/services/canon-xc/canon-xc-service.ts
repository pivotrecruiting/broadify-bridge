import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
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
  | "connection_refused"
  | "network_unreachable"
  | "permission_denied"
  | "camera_response";

export type CanonXCDiagnosticT = {
  code: CanonXCDiagnosticCodeT;
  hint: string;
  networkCode?: string;
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
  networkCode?: string | null;
  syscall?: string | null;
  address?: string | null;
  port?: number | null;
};

type NetworkErrorDetailsT = {
  message: string;
  networkCode: string | null;
  syscall: string | null;
  address: string | null;
  port: number | null;
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

const isExplicitlyDisabled = (value: string | undefined): boolean => {
  if (value == null) {
    return false;
  }

  return ["disabled", "disable", "off", "0", "false", "no", "none"].includes(
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
  // p.count is the NUMBER of stored presets, not the highest slot number —
  // slots are not necessarily contiguous (e.g. only slot 5 in use). Iterating
  // 1..count therefore dropped every preset stored in a higher slot. Derive
  // the actual slot numbers from the returned keys instead.
  const presetNumbers = new Set<number>();
  for (const key of Object.keys(info)) {
    const match = /^p\.(\d+)\./.exec(key);
    if (match) {
      presetNumbers.add(Number.parseInt(match[1], 10));
    }
  }
  const presets: CanonXCPresetT[] = [];

  for (const presetNo of Array.from(presetNumbers).sort((a, b) => a - b)) {
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

    // Occupied vs. empty slot: spec 005 marks empty slots with content:=disabled
    // (and disabled sub-flags, no name). Some CR-N firmwares deviate from the
    // spec example and report other content vocabulary for stored presets, so
    // anything that is not an explicit empty-slot marker counts as occupied.
    // A named slot is always a stored preset the operator can recall.
    const subContentEnabled = [ptz, focus, exp, wb, imageStabilizer, cp, lenscorrect].some(
      (value) => isEnabled(value),
    );
    const emptySlot =
      !name && !subContentEnabled && (content == null || isExplicitlyDisabled(content));
    if (emptySlot) {
      continue;
    }

    const contentEnabled = !isExplicitlyDisabled(content);

    presets.push({
      id: `${deviceId}:preset:${presetNo}`,
      deviceId,
      preset: presetNo,
      presetNo,
      label: name || `Preset ${presetNo}`,
      name: name || `Preset ${presetNo}`,
      // Every slot that survives the empty-slot filter is a stored preset and
      // must be recallable from the UI, regardless of its content flag.
      enabled: true,
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
    // item=s,p: s.* carries model/firmware and only arrives when requested.
    const response = await this.request(device, "info.cgi", { item: "s,p" });
    if (!response.ok) {
      return this.errorResponse(device, "Could not load Canon XC presets.", response);
    }

    const info = parseCanonInfo(response.text);
    const presets = presetsFromCanonInfo(device.deviceId, info);
    this.logPresetParseDiagnostics(device, info, presets);
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
    // p.count is the camera's slot capacity (always 100 on CR-N), not the
    // number of stored presets - report what we actually parsed.
    return {
      connected,
      host: device.host,
      model: info["s.hardware"] ?? info["s.model"] ?? info["s.product"] ?? null,
      firmware: info["s.firmware"] ?? null,
      presetCount: presets.length,
      presetsReady: presets.length > 0,
      lastError: null,
    };
  }

  /**
   * Logs raw preset keys when suspiciously few presets were parsed, so a
   * firmware that deviates from spec 005 shows up in one field log line
   * instead of another guessing round.
   */
  private logPresetParseDiagnostics(
    device: CanonXCDeviceT,
    info: Record<string, string>,
    presets: CanonXCPresetT[],
  ): void {
    if (presets.length > 1) {
      return;
    }

    const presetKeys = Object.keys(info).filter((key) => key.startsWith("p."));
    getBridgeContext().logger?.info?.(
      JSON.stringify({
        component: "canon-xc",
        message: "[CanonXC] Preset parse diagnostics",
        host: device.host,
        parsedPresets: presets.length,
        reportedCount: info["p.count"] ?? null,
        presetKeyCount: presetKeys.length,
        presetKeySample: presetKeys.slice(0, 40),
      }),
    );
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
        networkCode: response.networkCode ?? null,
        syscall: response.syscall ?? null,
        address: response.address ?? null,
        port: response.port ?? null,
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

    if (response.networkCode === "ETIMEDOUT" || error.includes("timed out")) {
      return {
        code: "timeout",
        hint: "Check the camera address, port, firewall, and local network access.",
        networkCode: response.networkCode ?? undefined,
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
      if (response.networkCode === "ECONNREFUSED") {
        return {
          code: "connection_refused",
          hint: "The camera host is reachable but refused the connection. Check the Canon port and selected HTTP/HTTPS protocol.",
          networkCode: response.networkCode,
        };
      }

      if (
        response.networkCode === "ENETUNREACH" ||
        response.networkCode === "EHOSTUNREACH"
      ) {
        return {
          code: "network_unreachable",
          hint: "The camera network is unreachable from this Mac. Check the active network interface, VLAN/subnet, routing, and macOS Local Network permission.",
          networkCode: response.networkCode,
        };
      }

      if (response.networkCode === "EPERM" || response.networkCode === "EACCES") {
        return {
          code: "permission_denied",
          hint: "macOS denied the local network connection. Check Local Network permission for Broadify Bridge and restart the app after changing it.",
          networkCode: response.networkCode,
        };
      }

      return {
        code: "network",
        hint: "Check the camera address, port, firewall, and macOS Local Network permission for Broadify Bridge.",
        networkCode: response.networkCode ?? undefined,
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
      const preflightError = await this.preflightTcpConnection(device);
      if (preflightError) {
        const result = {
          ok: false,
          text: "",
          statusCode: 0,
          headers: new Headers(),
          error: preflightError.message,
          networkCode: preflightError.networkCode,
          syscall: preflightError.syscall,
          address: preflightError.address,
          port: preflightError.port,
        };
        this.logRequest(device, command, result, startedAt);
        return result;
      }

      const url = this.buildUrl(device, command, params);
      let response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      // CR-N cameras default to Digest authentication, which fetch cannot
      // negotiate on its own: answer the 401 challenge once (RFC 7616).
      if (response.status === 401 && device.username && device.password) {
        const digestHeader = this.buildDigestAuthorization(
          device,
          "GET",
          url,
          response.headers.get("www-authenticate"),
        );
        if (digestHeader) {
          await response.text().catch(() => undefined);
          const retryHeaders = new Headers(headers);
          retryHeaders.set("Authorization", digestHeader);
          response = await fetch(url, {
            method: "GET",
            headers: retryHeaders,
            signal: controller.signal,
          });
        }
      }

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
        networkCode: null,
        syscall: null,
        address: null,
        port: null,
      };
      this.logRequest(device, command, result, startedAt);
      return result;
    } catch (error) {
      const networkError = this.networkErrorFromUnknown(error, device);
      const result = {
        ok: false,
        text: "",
        statusCode: 0,
        headers: new Headers(),
        error: networkError.message,
        networkCode: networkError.networkCode,
        syscall: networkError.syscall,
        address: networkError.address,
        port: networkError.port,
      };
      this.logRequest(device, command, result, startedAt);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Builds an RFC 7616 Digest Authorization header from a 401 challenge.
   * Returns null when the challenge is absent or not a Digest scheme.
   */
  private buildDigestAuthorization(
    device: CanonXCDeviceT,
    method: string,
    requestUrl: string,
    wwwAuthenticate: string | null,
  ): string | null {
    if (!wwwAuthenticate || !/^\s*digest\b/i.test(wwwAuthenticate)) {
      return null;
    }
    if (!device.username || !device.password) {
      return null;
    }

    const challenge: Record<string, string> = {};
    const paramPattern = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
    for (
      let match = paramPattern.exec(wwwAuthenticate);
      match;
      match = paramPattern.exec(wwwAuthenticate)
    ) {
      challenge[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    const realm = challenge.realm ?? "";
    const nonce = challenge.nonce;
    if (!nonce) {
      return null;
    }

    const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
    const hashName = algorithm.startsWith("SHA-256") ? "sha256" : "md5";
    const hash = (value: string): string =>
      createHash(hashName).update(value, "utf8").digest("hex");

    const parsedUrl = new URL(requestUrl);
    const uri = `${parsedUrl.pathname}${parsedUrl.search}`;
    const cnonce = randomBytes(8).toString("hex");
    const nc = "00000001";
    const qop = (challenge.qop ?? "")
      .split(",")
      .map((item) => item.trim())
      .includes("auth")
      ? "auth"
      : null;

    let ha1 = hash(`${device.username}:${realm}:${device.password}`);
    if (algorithm.endsWith("-SESS")) {
      ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
    }
    const ha2 = hash(`${method}:${uri}`);
    const response = qop
      ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : hash(`${ha1}:${nonce}:${ha2}`);

    const parts = [
      `username="${device.username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=${algorithm}`,
      `response="${response}"`,
    ];
    if (qop) {
      parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    }
    if (challenge.opaque) {
      parts.push(`opaque="${challenge.opaque}"`);
    }
    return `Digest ${parts.join(", ")}`;
  }

  private preflightTcpConnection(
    device: CanonXCDeviceT,
  ): Promise<NetworkErrorDetailsT | null> {
    return new Promise((resolve) => {
      const socket = net.createConnection({
        host: device.host,
        port: device.port,
      });
      let settled = false;

      const finish = (error: NetworkErrorDetailsT | null) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(error);
      };

      socket.setTimeout(Math.min(this.timeoutMs, 1_500), () => {
        finish({
          message: "Canon XC TCP preflight timed out.",
          networkCode: "ETIMEDOUT",
          syscall: "connect",
          address: device.host,
          port: device.port,
        });
      });
      socket.once("connect", () => finish(null));
      socket.once("error", (error) => {
        finish(this.networkErrorFromUnknown(error, device, "Canon XC TCP preflight failed."));
      });
    });
  }

  private networkErrorFromUnknown(
    error: unknown,
    device: CanonXCDeviceT,
    fallbackMessage?: string,
  ): NetworkErrorDetailsT {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        message: "Canon XC request timed out.",
        networkCode: "ETIMEDOUT",
        syscall: null,
        address: device.host,
        port: device.port,
      };
    }

    const errorRecord = this.errorRecord(error);
    const causeRecord = this.errorRecord(errorRecord?.cause);
    const source = causeRecord ?? errorRecord;
    const message =
      fallbackMessage ??
      (error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Canon XC request failed.");
    const causeMessage =
      causeRecord?.message && typeof causeRecord.message === "string"
        ? causeRecord.message
        : null;

    return {
      message: causeMessage ? `${message}: ${causeMessage}` : message,
      networkCode: this.optionalString(source?.code),
      syscall: this.optionalString(source?.syscall),
      address: this.optionalString(source?.address) ?? device.host,
      port: this.optionalNumber(source?.port) ?? device.port,
    };
  }

  private errorRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }

  private optionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private optionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
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
      networkCode: response.networkCode ?? null,
      syscall: response.syscall ?? null,
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
