import type { MacroT } from "../../engine-types.js";
import {
  EngineError,
  EngineErrorCode,
  createConnectionRefusedError,
  createConnectionTimeoutError,
  createDeviceUnreachableError,
  createNetworkError,
} from "../engine-errors.js";

type RequestParamsT = Record<string, string | number>;

export type VmixInputSummaryT = {
  number: number;
  key: string | null;
  title: string;
  shortTitle: string | null;
  type: string | null;
};

type VmixHttpClientOptionsT = {
  ip: string;
  port: number;
  requestTimeoutMs: number;
};

/**
 * Small HTTP client wrapper for the vMix Web API.
 *
 * Centralizes request building, timeout handling, and error normalization so the
 * adapter can focus on engine state transitions.
 */
export class VmixHttpClient {
  private readonly ip: string;
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: VmixHttpClientOptionsT) {
    this.ip = options.ip;
    this.port = options.port;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.baseUrl = `http://${options.ip}:${options.port}`;
  }

  async getVersion(): Promise<string> {
    return this.requestText("GetVersion");
  }

  async getMacros(): Promise<MacroT[]> {
    const responseText = await this.requestText("GetMacros");
    return parseVmixMacrosResponse(responseText);
  }

  async getInputs(): Promise<VmixInputSummaryT[]> {
    const responseText = await this.requestStateText();
    return parseVmixInputsResponse(responseText);
  }

  async startMacro(id: number): Promise<void> {
    await this.requestText("MacroStart", { Input: id });
  }

  async stopMacro(id: number): Promise<void> {
    await this.requestText("MacroStop", { Input: id });
  }

  async addBrowserInput(url: string): Promise<void> {
    await this.requestText("AddInput", {
      Value: `Browser|${url}`,
    });
  }

  async setInputName(input: string | number, name: string): Promise<void> {
    await this.requestText("SetInputName", {
      Input: input,
      Value: name,
    });
  }

  async navigateBrowserInput(
    input: string | number,
    url: string
  ): Promise<void> {
    await this.requestText("BrowserNavigate", {
      Input: input,
      Value: url,
    });
  }

  private async requestStateText(): Promise<string> {
    const response = await this.request();
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new EngineError(
        EngineErrorCode.PROTOCOL_ERROR,
        `vMix API request failed for state snapshot: ${response.status} ${responseBody || response.statusText}`,
        {
          ip: this.ip,
          port: this.port,
          status: response.status,
        },
      );
    }
    return response.text();
  }

  private async requestText(
    functionName: string,
    params?: RequestParamsT,
  ): Promise<string> {
    const response = await this.request(functionName, params);
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new EngineError(
        EngineErrorCode.PROTOCOL_ERROR,
        `vMix API request failed for ${functionName}: ${response.status} ${responseBody || response.statusText}`,
        {
          functionName,
          ip: this.ip,
          port: this.port,
          status: response.status,
        },
      );
    }
    return response.text();
  }

  private async request(
    functionName?: string,
    params?: RequestParamsT,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api`);
    if (functionName) {
      url.searchParams.set("Function", functionName);
    }

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/xml, application/json, text/xml, */*",
        },
      });
    } catch (error: unknown) {
      throw normalizeVmixRequestError(
        error,
        this.ip,
        this.port,
        this.requestTimeoutMs,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function parseVmixInputsResponse(
  responseText: string
): VmixInputSummaryT[] {
  const inputs: VmixInputSummaryT[] = [];

  try {
    const inputMatches = responseText.matchAll(/<input\b([^>]*)>/gi);

    for (const match of inputMatches) {
      const attributes = match[1] ?? "";
      const numberValue = getXmlAttribute(attributes, "number");
      const number = Number(numberValue);
      if (!Number.isFinite(number)) {
        continue;
      }

      inputs.push({
        number,
        key: getXmlAttribute(attributes, "key"),
        title: decodeXmlEntities(getXmlAttribute(attributes, "title")) ?? "",
        shortTitle: decodeXmlEntities(
          getXmlAttribute(attributes, "shortTitle"),
        ),
        type: getXmlAttribute(attributes, "type"),
      });
    }
  } catch {
    return [];
  }

  return inputs;
}

export function parseVmixMacrosResponse(responseText: string): MacroT[] {
  const macros: MacroT[] = [];

  try {
    if (responseText.includes("<vmix") || responseText.includes("<macros>")) {
      const macroMatches = responseText.matchAll(
        /<macro\b[^>]*\bnumber="(\d+)"[^>]*\bname="([^"]*)"[^>]*\brunning="([^"]*)"[^>]*\/?>/gi,
      );

      for (const match of macroMatches) {
        const id = parseInt(match[1] ?? "", 10);
        if (!Number.isFinite(id)) {
          continue;
        }

        const name = match[2]?.trim() || `Macro ${id}`;
        const running = match[3]?.toLowerCase() === "true";
        macros.push({
          id,
          name,
          status: running ? "running" : "idle",
        });
      }

      return macros;
    }

    const json = JSON.parse(responseText) as {
      macros?: Array<{
        number?: string | number;
        name?: string;
        running?: boolean;
      }>;
    };

    if (!Array.isArray(json.macros)) {
      return macros;
    }

    for (const macro of json.macros) {
      const id = Number(macro.number);
      if (!Number.isFinite(id)) {
        continue;
      }

      macros.push({
        id,
        name: typeof macro.name === "string" && macro.name.trim().length > 0
          ? macro.name
          : `Macro ${id}`,
        status: macro.running === true ? "running" : "idle",
      });
    }
  } catch {
    return [];
  }

  return macros;
}

function normalizeVmixRequestError(
  error: unknown,
  ip: string,
  port: number,
  timeoutMs: number,
): EngineError {
  if (error instanceof EngineError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return createConnectionTimeoutError(ip, port, timeoutMs);
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  if (
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("refused") ||
    errorMessage.includes("ECONNRESET")
  ) {
    return createConnectionRefusedError(ip, port);
  }

  if (
    errorMessage.includes("ENOTFOUND") ||
    errorMessage.includes("EHOSTUNREACH") ||
    errorMessage.includes("getaddrinfo")
  ) {
    return createDeviceUnreachableError(ip, port);
  }

  if (
    errorMessage.includes("ETIMEDOUT") ||
    errorMessage.includes("timeout") ||
    errorMessage.includes("aborted")
  ) {
    return createConnectionTimeoutError(ip, port, timeoutMs);
  }

  return createNetworkError(
    ip,
    port,
    error instanceof Error ? error : undefined,
  );
}

function getXmlAttribute(
  attributes: string,
  attributeName: string
): string | null {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escapedName}="([^"]*)"`, "i").exec(
    attributes,
  );
  return match?.[1] ?? null;
}

function decodeXmlEntities(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
