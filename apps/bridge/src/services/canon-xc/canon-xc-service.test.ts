import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  CanonXCService,
  parseCanonInfo,
  presetsFromCanonInfo,
} from "./canon-xc-service.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
};

jest.mock("node:fs/promises", () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("node:net", () => ({
  __esModule: true,
  default: {
    createConnection: jest.fn(),
  },
}));

jest.mock("../bridge-context.js", () => ({
  getBridgeContext: jest.fn(() => ({
    userDataDir: "/tmp/broadify-test",
    logger: mockLogger,
  })),
}));

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockCreateConnection = net.createConnection as jest.MockedFunction<
  typeof net.createConnection
>;

const mockTcpConnectSuccess = () => {
  mockCreateConnection.mockImplementation(() => {
    const socket = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    socket.setTimeout = jest.fn();
    socket.destroy = jest.fn();
    process.nextTick(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
};

const mockTcpConnectError = (error: NodeJS.ErrnoException) => {
  mockCreateConnection.mockImplementation(() => {
    const socket = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    socket.setTimeout = jest.fn();
    socket.destroy = jest.fn();
    process.nextTick(() => socket.emit("error", error));
    return socket as unknown as net.Socket;
  });
};

const responseWithText = (
  text: string,
  init?: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    livescope?: string | null;
    wwwAuthenticate?: string | null;
  },
) =>
  ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: {
      get: jest.fn((name: string) => {
        if (name.toLowerCase() === "livescope-status") {
          return init?.livescope ?? null;
        }
        if (name.toLowerCase() === "www-authenticate") {
          return init?.wwwAuthenticate ?? null;
        }
        return null;
      }),
    },
    text: jest.fn().mockResolvedValue(text),
  }) as unknown as Response;

describe("canon-xc-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error("not found"));
    mockTcpConnectSuccess();
    global.fetch = jest.fn().mockResolvedValue(responseWithText("")) as jest.Mock;
  });

  describe("parseCanonInfo", () => {
    it("parses Canon key/value response formats and ignores comments", () => {
      expect(
        parseCanonInfo(`
          # Canon response
          p.count:=2
          p.1.name.utf8=Wide
          p.2.name==Close
        `),
      ).toEqual({
        "p.count": "2",
        "p.1.name.utf8": "Wide",
        "p.2.name": "Close",
      });
    });
  });

  describe("presetsFromCanonInfo", () => {
    it("builds enabled presets from documented Canon preset fields", () => {
      const presets = presetsFromCanonInfo("canon-1", {
        "p.count": "2",
        "p.1.name.utf8": "Wide",
        "p.1.content": "enabled",
        "p.1.content.ptz": "enabled",
        "p.2.name": "Close",
        "p.2.content": "disabled",
      });

      expect(presets).toHaveLength(2);
      expect(presets[0]).toMatchObject({
        deviceId: "canon-1",
        preset: 1,
        label: "Wide",
        enabled: true,
        ptzEnabled: true,
      });
      // A NAMED slot is a stored preset the operator can recall, even when the
      // camera reports its content flag as disabled (CR-N firmwares deviate
      // from the 005 spec example here). It must stay visible and triggerable.
      expect(presets[1]).toMatchObject({
        preset: 2,
        label: "Close",
        enabled: true,
        contentEnabled: false,
      });
    });

    it("keeps occupied slots whose content value uses unknown vocabulary", () => {
      // CR-N models not covered by spec 005 may report content as a stored-item
      // list or other vocabulary instead of enabled/disabled. Anything that is
      // not an explicit empty-slot marker counts as occupied.
      const presets = presetsFromCanonInfo("canon-1", {
        "p.count": "100",
        "p.3.content": "ptz+focus+exp",
        "p.7.name.utf8": "Buehne links",
        "p.7.content": "unknown-value",
      });

      expect(presets.map((preset) => preset.preset)).toEqual([3, 7]);
      expect(presets[0]).toMatchObject({ preset: 3, enabled: true });
      expect(presets[1]).toMatchObject({
        preset: 7,
        label: "Buehne links",
        enabled: true,
      });
    });

    it("still drops spec-conform empty slots (content and sub-flags disabled, no name)", () => {
      const presets = presetsFromCanonInfo("canon-1", {
        "p.count": "100",
        "p.1.name.utf8": "home",
        "p.1.content": "enabled",
        "p.2.content": "disabled",
        "p.2.content.ptz": "disabled",
        "p.2.content.focus": "disabled",
        "p.3.content": "disabled",
      });

      expect(presets).toHaveLength(1);
      expect(presets[0]).toMatchObject({ preset: 1, label: "home" });
    });

    it("includes presets in non-contiguous slots (p.count is a count, not a max slot)", () => {
      const presets = presetsFromCanonInfo("canon-1", {
        "p.count": "1",
        "p.5.name.utf8": "Stage Right",
        "p.5.content": "enabled",
        "p.5.content.ptz": "enabled",
      });

      expect(presets).toHaveLength(1);
      expect(presets[0]).toMatchObject({
        preset: 5,
        label: "Stage Right",
        enabled: true,
      });
    });
  });

  describe("device persistence", () => {
    it("saves devices with defaults and preserves existing passwords on update", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          devices: [
            {
              deviceId: "canon-1",
              name: "Old Canon",
              host: "192.168.0.10",
              port: 80,
              protocol: "http",
              type: "camera",
              username: "operator",
              password: "secret",
              cameraNo: null,
              enabled: true,
            },
          ],
        }),
      );
      const service = new CanonXCService();

      const device = await service.saveDevice({
        deviceId: "canon-1",
        name: "Updated Canon",
        host: "192.168.0.11",
      });

      expect(device).toMatchObject({
        deviceId: "canon-1",
        name: "Updated Canon",
        host: "192.168.0.11",
        port: 80,
        protocol: "http",
      });
      expect(device).not.toHaveProperty("password");
      expect(mockMkdir).toHaveBeenCalledWith(
        path.join("/tmp/broadify-test", "studio-adapters"),
        {
          recursive: true,
        },
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(
          "/tmp/broadify-test",
          "studio-adapters",
          "canon-xc-devices.json",
        ),
        expect.stringContaining('"password": "secret"'),
        "utf8",
      );
    });
  });

  describe("Canon HTTP commands", () => {
    it("loads presets and device info from info.cgi?item=s,p", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          devices: [
            {
              deviceId: "canon-1",
              name: "Canon 1",
              host: "192.168.0.100",
              port: 80,
              protocol: "http",
              type: "camera",
              username: "operator",
              password: "secret",
              cameraNo: null,
              enabled: true,
            },
          ],
        }),
      );
      global.fetch = jest.fn().mockResolvedValue(
        responseWithText(`
          s.hardware:=CR-N400
          s.firmware:=1.1.0
          p.count:=100
          p.1.name.utf8=Wide
          p.1.content=enabled
        `),
      ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.listPresets("canon-1");

      expect(result.ok).toBe(true);
      expect(result.presets).toHaveLength(1);
      // s.* fields only arrive with item=s; p.count is the slot capacity (100),
      // not the number of stored presets - presetCount must reflect what we
      // actually parsed.
      expect(result.status).toMatchObject({
        model: "CR-N400",
        firmware: "1.1.0",
        presetCount: 1,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "http://192.168.0.100/-wvhttp-01-/info.cgi?item=s%2Cp",
        expect.objectContaining({
          method: "GET",
          headers: expect.any(Headers),
        }),
      );
      const headers = (global.fetch as jest.Mock).mock.calls[0][1]
        .headers as Headers;
      expect(headers.get("Authorization")).toBe(
        `Basic ${Buffer.from("operator:secret", "utf8").toString("base64")}`,
      );
    });

    it("answers a Digest challenge and retries the request (CR-N factory default)", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          devices: [
            {
              deviceId: "canon-1",
              name: "Canon 1",
              host: "192.168.0.100",
              port: 80,
              protocol: "http",
              type: "camera",
              username: "operator",
              password: "secret",
              cameraNo: null,
              enabled: true,
            },
          ],
        }),
      );
      const challenge =
        'Digest realm="camera", nonce="abc123", qop="auth", algorithm=MD5';
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          responseWithText("Unauthorized", {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            wwwAuthenticate: challenge,
          }),
        )
        .mockResolvedValueOnce(
          responseWithText("p.count:=1\np.1.name.utf8=Wide\np.1.content=enabled"),
        ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.listPresets("canon-1");

      expect(result.ok).toBe(true);
      expect(result.presets).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const retryHeaders = (global.fetch as jest.Mock).mock.calls[1][1]
        .headers as Headers;
      const authorization = retryHeaders.get("Authorization") ?? "";
      expect(authorization).toMatch(/^Digest /);
      expect(authorization).toContain('username="operator"');
      expect(authorization).toContain('realm="camera"');
      expect(authorization).toContain('nonce="abc123"');
      expect(authorization).toContain('uri="/-wvhttp-01-/info.cgi?item=s%2Cp"');
      expect(authorization).toContain("qop=auth");
      expect(authorization).toMatch(/response="[0-9a-f]{32}"/);
    });

    it("keeps the authentication diagnostic when the Digest retry is rejected too", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          devices: [
            {
              deviceId: "canon-1",
              name: "Canon 1",
              host: "192.168.0.100",
              port: 80,
              protocol: "http",
              type: "camera",
              username: "operator",
              password: "wrong",
              cameraNo: null,
              enabled: true,
            },
          ],
        }),
      );
      global.fetch = jest.fn().mockResolvedValue(
        responseWithText("Unauthorized", {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          wwwAuthenticate: 'Digest realm="camera", nonce="abc123", qop="auth"',
        }),
      ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.listPresets("canon-1");

      expect(result.ok).toBe(false);
      expect(result.diagnostic).toMatchObject({ code: "authentication" });
      // one challenge + one retry, no endless loop
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("tests a connection without persisting it and preserves its saved password", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          devices: [
            {
              deviceId: "canon-1",
              name: "Canon 1",
              host: "192.168.0.100",
              port: 80,
              protocol: "http",
              type: "camera",
              username: "operator",
              password: "secret",
              cameraNo: null,
              enabled: true,
            },
          ],
        }),
      );
      global.fetch = jest.fn().mockResolvedValue(
        responseWithText("p.count:=0"),
      ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.testConnection({
        deviceId: "canon-1",
        name: "Canon 1",
        host: "192.168.0.101",
        port: 80,
        protocol: "http",
        type: "camera",
        username: "operator",
      });

      expect(result.ok).toBe(true);
      expect(mockWriteFile).not.toHaveBeenCalled();
      const headers = (global.fetch as jest.Mock).mock.calls[0][1]
        .headers as Headers;
      expect(headers.get("Authorization")).toBe(
        `Basic ${Buffer.from("operator:secret", "utf8").toString("base64")}`,
      );
    });

    it("returns a safe authentication diagnostic for rejected credentials", async () => {
      global.fetch = jest.fn().mockResolvedValue(
        responseWithText("Unauthorized", {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
        }),
      ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.testConnection({
        name: "Canon 1",
        host: "192.168.0.100",
      });

      expect(result).toMatchObject({
        ok: false,
        rawError: "HTTP 401: Unauthorized",
        diagnostic: {
          code: "authentication",
          hint: "Check the Canon username, password, and assigned access rights.",
        },
      });
    });

    it("returns a macOS local network diagnostic for permission denied", async () => {
      mockTcpConnectError(
        Object.assign(new Error("operation not permitted"), {
          code: "EPERM",
          syscall: "connect",
          address: "192.168.0.100",
          port: 80,
        }),
      );
      const service = new CanonXCService();

      const result = await service.testConnection({
        name: "Canon 1",
        host: "192.168.0.100",
      });

      expect(result).toMatchObject({
        ok: false,
        rawError: expect.stringContaining("Canon XC TCP preflight failed"),
        diagnostic: {
          code: "permission_denied",
          networkCode: "EPERM",
        },
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("classifies refused Canon ports before issuing HTTP requests", async () => {
      mockTcpConnectError(
        Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
          address: "192.168.0.100",
          port: 80,
        }),
      );
      const service = new CanonXCService();

      const result = await service.testConnection({
        name: "Canon 1",
        host: "192.168.0.100",
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostic: {
          code: "connection_refused",
          networkCode: "ECONNREFUSED",
        },
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("keeps fetch cause details when HTTP fetch fails after TCP preflight", async () => {
      global.fetch = jest.fn().mockRejectedValue(
        Object.assign(new Error("fetch failed"), {
          cause: Object.assign(new Error("host unreachable"), {
            code: "EHOSTUNREACH",
            syscall: "connect",
            address: "192.168.0.100",
            port: 80,
          }),
        }),
      ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.testConnection({
        name: "Canon 1",
        host: "192.168.0.100",
      });

      expect(result).toMatchObject({
        ok: false,
        rawError: "fetch failed: host unreachable",
        diagnostic: {
          code: "network_unreachable",
          networkCode: "EHOSTUNREACH",
        },
      });
    });

    it("redacts credential fragments from Canon request logs", async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("password=super-secret connection failed")) as jest.Mock;
      const service = new CanonXCService();

      await service.testConnection({
        name: "Canon 1",
        host: "192.168.0.100",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.not.stringContaining("super-secret"),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("password=[redacted]"),
      );
    });

    it("recalls presets through control.cgi with documented parameters", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          devices: [
            {
              deviceId: "canon-1",
              name: "Canon 1",
              host: "192.168.0.100",
              port: 80,
              protocol: "http",
              type: "camera",
              username: null,
              password: null,
              cameraNo: null,
              enabled: true,
            },
          ],
        }),
      );
      global.fetch = jest.fn().mockResolvedValue(responseWithText("OK")) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.recallPreset("canon-1", 3, {
        ptzspeed: 30,
        freeze: true,
      });

      expect(result.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://192.168.0.100/-wvhttp-01-/control.cgi?p=3&p.ptzspeed=30&p.freeze=on",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});
