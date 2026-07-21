import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getBridgeContext, type LoggerLikeT } from "../bridge-context.js";

const getLogger = (): LoggerLikeT => {
  try {
    return getBridgeContext().logger;
  } catch {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }
};

const STORE_DIR = "power";
const STORE_FILE = "sockets.json";
const REQUEST_TIMEOUT_MS = 6000;

/**
 * How a socket is addressed. Presets build the on/off URLs from just an IP so a
 * non-technical operator never types a URL; "custom" lets any HTTP-controllable
 * device work by pasting its own on/off URLs.
 */
export type PowerSocketPresetT =
  | "shelly_gen1"
  | "shelly_gen2"
  | "tasmota"
  | "custom";

export type PowerHttpMethodT = "GET" | "POST";
export type PowerSocketStateT = "on" | "off" | "unknown";

export type PowerSocketT = {
  id: string;
  name: string;
  preset: PowerSocketPresetT;
  /** IP/host (with optional :port) for presets; null for custom. */
  host: string | null;
  onUrl: string;
  offUrl: string;
  method: PowerHttpMethodT;
  /** Switch this socket on automatically when the operator runs Autostart. */
  autostart: boolean;
  lastState: PowerSocketStateT;
  lastError: string | null;
};

export type PowerSocketInputT = {
  id?: string;
  name?: string;
  preset?: PowerSocketPresetT;
  host?: string | null;
  onUrl?: string;
  offUrl?: string;
  method?: PowerHttpMethodT;
  autostart?: boolean;
};

export type PowerSocketActionResultT = {
  ok: boolean;
  state: PowerSocketStateT;
  statusCode: number | null;
  error: string | null;
};

type SocketsFileT = {
  sockets?: PowerSocketT[];
  updatedAt?: string;
};

/** Builds the on/off URLs for a known brand from a host, or null for custom. */
function buildPresetUrls(
  preset: PowerSocketPresetT,
  host: string,
): { onUrl: string; offUrl: string } | null {
  const h = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  switch (preset) {
    case "shelly_gen1":
      return {
        onUrl: `http://${h}/relay/0?turn=on`,
        offUrl: `http://${h}/relay/0?turn=off`,
      };
    case "shelly_gen2":
      return {
        onUrl: `http://${h}/rpc/Switch.Set?id=0&on=true`,
        offUrl: `http://${h}/rpc/Switch.Set?id=0&on=false`,
      };
    case "tasmota":
      return {
        onUrl: `http://${h}/cm?cmnd=Power%20On`,
        offUrl: `http://${h}/cm?cmnd=Power%20Off`,
      };
    default:
      return null;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True if a literal IPv4 falls in a range we must never reach from operator-
 * supplied plug URLs: loopback (127.0.0.0/8) and link-local / cloud-metadata
 * (169.254.0.0/16, incl. 169.254.169.254). Private LAN ranges stay allowed.
 */
function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)
  ) {
    return true; // malformed → refuse rather than risk it
  }
  const [a, b] = octets;
  if (a === 127) {
    return true; // 127.0.0.0/8 loopback
  }
  if (a === 169 && b === 254) {
    return true; // 169.254.0.0/16 link-local + cloud metadata
  }
  return false;
}

/** True if a literal IP (v4 or v6) is loopback/link-local and must be blocked. */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isBlockedIpv4(ip);
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") {
      return true; // loopback
    }
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isBlockedIpv4(mapped[1]); // IPv4-mapped IPv6
    }
    if (/^fe[89ab]/.test(lower)) {
      return true; // fe80::/10 link-local
    }
    return false;
  }
  return false; // not a literal IP — caller resolves DNS first
}

/**
 * Guards an operator-supplied plug URL before we fetch it. The legitimate scope
 * is LAN smart plugs, so we hard-block loopback, link-local and cloud-metadata
 * targets. DNS names are resolved and the *resolved* IP is checked, closing the
 * DNS-rebinding hole. Throws with a clear message when the host is disallowed.
 */
async function assertAllowedPlugHost(url: string): Promise<void> {
  let rawHost: string;
  try {
    rawHost = new URL(url).hostname;
  } catch {
    throw new Error("Invalid target URL.");
  }
  const host = rawHost.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error(`Refusing to reach loopback host: ${host}`);
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error(`Refusing to reach non-LAN address: ${host}`);
    }
    return;
  }
  // DNS name: resolve and validate the actual IP to prevent DNS rebinding.
  let resolved: string;
  try {
    resolved = (await lookup(host)).address;
  } catch {
    return; // let fetch surface the real network error
  }
  if (isBlockedIp(resolved)) {
    throw new Error(`Refusing to reach non-LAN address: ${host} → ${resolved}`);
  }
}

/**
 * Manages the operator's IP power sockets (smart plugs) and switches them on/off
 * over HTTP — the common local control path for Shelly, Tasmota and any device
 * with an HTTP endpoint. Definitions persist to
 * `.bridge-data/power/sockets.json`, mirroring the other bridge services, so the
 * list survives a restart. No cloud, no account.
 */
export class PowerSocketService {
  private sockets: PowerSocketT[] | null = null;

  async list(): Promise<PowerSocketT[]> {
    await this.ensureLoaded();
    return (this.sockets ?? []).map((socket) => ({ ...socket }));
  }

  async save(input: PowerSocketInputT): Promise<PowerSocketT> {
    await this.ensureLoaded();

    const name = (input.name ?? "").trim();
    if (!name) {
      throw new Error("Name is required.");
    }
    const preset: PowerSocketPresetT = input.preset ?? "custom";
    const method: PowerHttpMethodT = input.method === "POST" ? "POST" : "GET";

    let onUrl: string;
    let offUrl: string;
    let host: string | null = null;

    if (preset === "custom") {
      onUrl = (input.onUrl ?? "").trim();
      offUrl = (input.offUrl ?? "").trim();
      if (!isHttpUrl(onUrl) || !isHttpUrl(offUrl)) {
        throw new Error("On and off URLs must be valid http(s) URLs.");
      }
    } else {
      host = (input.host ?? "").trim();
      if (!host) {
        throw new Error("An IP address / host is required for this preset.");
      }
      const urls = buildPresetUrls(preset, host);
      if (!urls) {
        throw new Error(`Unknown preset: ${preset}`);
      }
      onUrl = urls.onUrl;
      offUrl = urls.offUrl;
    }

    const existing = input.id
      ? (this.sockets ?? []).find((socket) => socket.id === input.id)
      : undefined;

    const socket: PowerSocketT = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name,
      preset,
      host,
      onUrl,
      offUrl,
      method,
      autostart: input.autostart ?? existing?.autostart ?? true,
      lastState: existing?.lastState ?? "unknown",
      lastError: null,
    };

    const next = (this.sockets ?? []).filter((s) => s.id !== socket.id);
    next.push(socket);
    this.sockets = next;
    await this.persist();
    return { ...socket };
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    await this.ensureLoaded();
    const before = this.sockets?.length ?? 0;
    this.sockets = (this.sockets ?? []).filter((socket) => socket.id !== id);
    const removed = (this.sockets.length ?? 0) < before;
    if (removed) {
      await this.persist();
    }
    return { removed };
  }

  /** Switches a socket on or off by calling its configured URL. */
  async setState(id: string, on: boolean): Promise<PowerSocketActionResultT> {
    await this.ensureLoaded();
    const socket = (this.sockets ?? []).find((item) => item.id === id);
    if (!socket) {
      throw new Error(`Unknown socket: ${id}`);
    }

    const url = on ? socket.onUrl : socket.offUrl;
    const result = await this.request(url, socket.method);

    socket.lastState = result.ok ? (on ? "on" : "off") : "unknown";
    socket.lastError = result.error;
    await this.persist();

    return {
      ok: result.ok,
      state: socket.lastState,
      statusCode: result.statusCode,
      error: result.error,
    };
  }

  /** Lightweight reachability check to the device (no state change). */
  async test(id: string): Promise<PowerSocketActionResultT> {
    await this.ensureLoaded();
    const socket = (this.sockets ?? []).find((item) => item.id === id);
    if (!socket) {
      throw new Error(`Unknown socket: ${id}`);
    }
    // Hit the device origin — any HTTP response means it is reachable.
    const origin = (() => {
      try {
        return new URL(socket.onUrl).origin;
      } catch {
        return socket.onUrl;
      }
    })();
    const result = await this.request(origin, "GET");
    // A 404/405 from the origin still proves the device answered.
    const reachable = result.ok || result.statusCode != null;
    socket.lastError = reachable ? null : result.error;
    await this.persist();
    return {
      ok: reachable,
      state: socket.lastState,
      statusCode: result.statusCode,
      error: reachable ? null : result.error,
    };
  }

  private async request(
    url: string,
    method: PowerHttpMethodT,
  ): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
    try {
      await assertAllowedPlugHost(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(
        `[PowerSocket] Blocked outbound request to disallowed host: ${message}`,
      );
      return { ok: false, statusCode: null, error: message };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        // "manual" keeps a redirect from bouncing us to an internal target.
        redirect: "manual",
      });
      return {
        ok: response.ok,
        statusCode: response.status,
        error: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === "AbortError"
            ? "Timed out — device did not respond."
            : error.message
          : String(error);
      return { ok: false, statusCode: null, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Persistence -----------------------------------------------------------

  private storePath(): string | null {
    try {
      return path.join(getBridgeContext().userDataDir, STORE_DIR, STORE_FILE);
    } catch {
      return null;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.sockets !== null) {
      return;
    }
    const file = this.storePath();
    if (!file) {
      this.sockets = [];
      return;
    }
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as SocketsFileT;
      this.sockets = Array.isArray(parsed.sockets)
        ? parsed.sockets.map((socket) => ({
            ...socket,
            autostart: socket.autostart ?? true,
          }))
        : [];
    } catch (error) {
      this.sockets = [];
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return; // no file yet — first run, nothing to recover
      }
      // The file exists but is unreadable/corrupt. Preserve it instead of
      // silently dropping every saved socket, and surface it in the logs.
      const message = error instanceof Error ? error.message : String(error);
      try {
        await rename(file, `${file}.corrupt`);
        getLogger().warn(
          `[PowerSocket] ${STORE_FILE} was unreadable and was moved to ${STORE_FILE}.corrupt: ${message}`,
        );
      } catch (renameError) {
        const renameMessage =
          renameError instanceof Error
            ? renameError.message
            : String(renameError);
        getLogger().warn(
          `[PowerSocket] ${STORE_FILE} was unreadable and could not be preserved (${renameMessage}); original error: ${message}`,
        );
      }
    }
  }

  private async persist(): Promise<void> {
    const file = this.storePath();
    if (!file) {
      return;
    }
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const data: SocketsFileT = {
        sockets: this.sockets ?? [],
        updatedAt: new Date().toISOString(),
      };
      // Write to a temp file then atomically rename, so a crash mid-write can
      // never leave a truncated/corrupt sockets.json behind.
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await rename(tmp, file);
    } catch (error) {
      // Persistence is best-effort; the in-memory list stays authoritative.
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(
        `[PowerSocket] Failed to persist ${STORE_FILE}: ${message}`,
      );
    }
  }
}

/** Process-wide singleton, mirroring the other bridge services. */
export const powerSocketService = new PowerSocketService();
