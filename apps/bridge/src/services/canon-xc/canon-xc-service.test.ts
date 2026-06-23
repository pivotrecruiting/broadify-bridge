import { readFile, writeFile, mkdir } from "node:fs/promises";

import {
  CanonXCService,
  parseCanonInfo,
  presetsFromCanonInfo,
} from "./canon-xc-service.js";

jest.mock("node:fs/promises", () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../bridge-context.js", () => ({
  getBridgeContext: jest.fn(() => ({
    userDataDir: "/tmp/broadify-test",
  })),
}));

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;

const responseWithText = (
  text: string,
  init?: { ok?: boolean; status?: number; statusText?: string; livescope?: string | null },
) =>
  ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: {
      get: jest.fn((name: string) =>
        name.toLowerCase() === "livescope-status"
          ? (init?.livescope ?? null)
          : null,
      ),
    },
    text: jest.fn().mockResolvedValue(text),
  }) as unknown as Response;

describe("canon-xc-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error("not found"));
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
      expect(presets[1]).toMatchObject({
        preset: 2,
        label: "Close",
        enabled: false,
        contentEnabled: false,
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
      expect(mockMkdir).toHaveBeenCalledWith("/tmp/broadify-test/studio-adapters", {
        recursive: true,
      });
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/tmp/broadify-test/studio-adapters/canon-xc-devices.json",
        expect.stringContaining('"password": "secret"'),
        "utf8",
      );
    });
  });

  describe("Canon HTTP commands", () => {
    it("loads presets from info.cgi?item=p", async () => {
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
          p.count:=1
          p.1.name.utf8=Wide
          p.1.content=enabled
        `),
      ) as jest.Mock;
      const service = new CanonXCService();

      const result = await service.listPresets("canon-1");

      expect(result.ok).toBe(true);
      expect(result.presets).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://192.168.0.100/-wvhttp-01-/info.cgi?item=p",
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
