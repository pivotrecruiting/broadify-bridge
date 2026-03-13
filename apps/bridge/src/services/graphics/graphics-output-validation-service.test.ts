import { setBridgeContext } from "../bridge-context.js";
import {
  validateOutputTargets,
  validateOutputFormat,
} from "./graphics-output-validation-service.js";

const mockGetDevices = jest.fn();
jest.mock("../device-cache.js", () => ({
  deviceCache: { getDevices: (...args: unknown[]) => mockGetDevices(...args) },
}));

const mockListDecklinkDisplayModes = jest.fn();
jest.mock("../../modules/decklink/decklink-helper.js", () => ({
  listDecklinkDisplayModes: (...args: unknown[]) =>
    mockListDecklinkDisplayModes(...args),
}));

/** Minimal device/port shape used by findDevicePort in validation. */
function makeDecklinkDevice(overrides: {
  id?: string;
  ports?: Array<{
    id: string;
    type: string;
    role?: string;
    status?: { available: boolean };
  }>;
}) {
  const { id = "deck-1", ports = [] } = overrides;
  return {
    id,
    type: "decklink" as const,
    ports,
  };
}

function makeDisplayDevice(overrides: {
  id?: string;
  ports?: Array<{
    id: string;
    type: string;
    capabilities?: { modes?: Array<{ width: number; height: number; fps: number }> };
  }>;
}) {
  const { id = "disp-1", ports = [] } = overrides;
  return {
    id,
    type: "display" as const,
    ports,
  };
}

describe("validateOutputTargets", () => {
  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });
    jest.clearAllMocks();
  });

  describe("key_fill_sdi", () => {
    it("throws when output1Id or output2Id is missing", async () => {
      await expect(
        validateOutputTargets("key_fill_sdi", { output1Id: "p1" })
      ).rejects.toThrow("Output 1 and Output 2 are required");
      await expect(
        validateOutputTargets("key_fill_sdi", { output2Id: "p2" })
      ).rejects.toThrow("Output 1 and Output 2 are required");
    });

    it("throws when output1Id and output2Id are the same", async () => {
      mockGetDevices.mockResolvedValue([]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "same",
          output2Id: "same",
        })
      ).rejects.toThrow("Output 1 and Output 2 must be different");
    });

    it("throws when output ports are not found", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [{ id: "fill-1", type: "sdi", role: "fill", status: { available: true } }],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-unknown",
        })
      ).rejects.toThrow("Invalid output ports selected");
    });

    it("throws when ports belong to different devices", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          id: "deck-1",
          ports: [
            { id: "fill-1", type: "sdi", role: "fill", status: { available: true } },
          ],
        }),
        makeDecklinkDevice({
          id: "deck-2",
          ports: [
            { id: "key-1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-1",
        })
      ).rejects.toThrow("Output ports must belong to the same device");
    });

    it("throws when port types are not SDI", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "fill-1", type: "hdmi", role: "fill", status: { available: true } },
            { id: "key-1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-1",
        })
      ).rejects.toThrow("Key & Fill SDI requires SDI output ports");
    });

    it("throws when output1 is not fill role", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "fill-1", type: "sdi", role: "key", status: { available: true } },
            { id: "key-1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-1",
        })
      ).rejects.toThrow("Output 1 must be the SDI Fill port");
    });

    it("throws when output2 is not key role", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "fill-1", type: "sdi", role: "fill", status: { available: true } },
            { id: "key-1", type: "sdi", role: "fill", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-1",
        })
      ).rejects.toThrow("Output 2 must be the SDI Key port");
    });

    it("throws when port is not available (and not current DeckLink target)", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "fill-1", type: "sdi", role: "fill", status: { available: false } },
            { id: "key-1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-1",
        })
      ).rejects.toThrow("Selected output ports are not available");
    });

    it("resolves when both ports are valid and available", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "fill-1", type: "sdi", role: "fill", status: { available: true } },
            { id: "key-1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("key_fill_sdi", {
          output1Id: "fill-1",
          output2Id: "key-1",
        })
      ).resolves.toBeUndefined();
    });

    it("allows busy DeckLink port when it is current output config target", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "fill-1", type: "sdi", role: "fill", status: { available: false } },
            { id: "key-1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets(
          "key_fill_sdi",
          { output1Id: "fill-1", output2Id: "key-1" },
          {
            currentOutputConfig: {
              version: 1,
              outputKey: "key_fill_sdi",
              targets: { output1Id: "fill-1", output2Id: "key-1" },
              format: { width: 1920, height: 1080, fps: 50 },
              range: "legal",
              colorspace: "auto",
            },
          }
        )
      ).resolves.toBeUndefined();
    });
  });

  describe("video_sdi", () => {
    it("throws when output1Id is missing", async () => {
      await expect(
        validateOutputTargets("video_sdi", {})
      ).rejects.toThrow("Output 1 is required for Video SDI");
    });

    it("throws when port is not found", async () => {
      mockGetDevices.mockResolvedValue([]);

      await expect(
        validateOutputTargets("video_sdi", { output1Id: "unknown" })
      ).rejects.toThrow("Invalid output port selected");
    });

    it("throws when port type is not SDI", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [{ id: "p1", type: "hdmi", status: { available: true } }],
        }),
      ]);

      await expect(
        validateOutputTargets("video_sdi", { output1Id: "p1" })
      ).rejects.toThrow("Video SDI requires an SDI output port");
    });

    it("throws when port is key role", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "p1", type: "sdi", role: "key", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("video_sdi", { output1Id: "p1" })
      ).rejects.toThrow("Video SDI cannot use the SDI Key port");
    });

    it("resolves when port is valid SDI fill", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [
            { id: "p1", type: "sdi", role: "fill", status: { available: true } },
          ],
        }),
      ]);

      await expect(
        validateOutputTargets("video_sdi", { output1Id: "p1" })
      ).resolves.toBeUndefined();
    });
  });

  describe("video_hdmi", () => {
    it("throws when output1Id is missing", async () => {
      await expect(
        validateOutputTargets("video_hdmi", {})
      ).rejects.toThrow("Output 1 is required for Video HDMI");
    });

    it("throws when port type is not HDMI/DisplayPort/Thunderbolt", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [{ id: "p1", type: "sdi", status: { available: true } }],
        }),
      ]);

      await expect(
        validateOutputTargets("video_hdmi", { output1Id: "p1" })
      ).rejects.toThrow(
        "Video HDMI requires an HDMI/DisplayPort/Thunderbolt output port"
      );
    });

    it("resolves when port is HDMI", async () => {
      mockGetDevices.mockResolvedValue([
        makeDecklinkDevice({
          ports: [{ id: "p1", type: "hdmi", status: { available: true } }],
        }),
      ]);

      await expect(
        validateOutputTargets("video_hdmi", { output1Id: "p1" })
      ).resolves.toBeUndefined();
    });
  });
});

describe("validateOutputFormat", () => {
  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });
    jest.clearAllMocks();
  });

  it("returns without validation for stub outputKey", async () => {
    await expect(
      validateOutputFormat("stub", {}, { width: 1920, height: 1080, fps: 50 })
    ).resolves.toBeUndefined();
    expect(mockGetDevices).not.toHaveBeenCalled();
  });

  it("returns without validation for key_fill_ndi outputKey", async () => {
    await expect(
      validateOutputFormat(
        "key_fill_ndi",
        {},
        { width: 1920, height: 1080, fps: 50 }
      )
    ).resolves.toBeUndefined();
  });

  it("throws when display has no matching mode", async () => {
    mockGetDevices.mockResolvedValue([
      makeDisplayDevice({
        ports: [
          {
            id: "disp-out-1",
            type: "hdmi",
            capabilities: {
              modes: [{ width: 1280, height: 720, fps: 60 }],
            },
          },
        ],
      }),
    ]);

    await expect(
      validateOutputFormat(
        "video_hdmi",
        { output1Id: "disp-out-1" },
        { width: 1920, height: 1080, fps: 50 }
      )
    ).rejects.toThrow("Output format not supported by selected display");
  });

  it("resolves when display has matching mode", async () => {
    mockGetDevices.mockResolvedValue([
      makeDisplayDevice({
        ports: [
          {
            id: "disp-out-1",
            type: "hdmi",
            capabilities: {
              modes: [{ width: 1920, height: 1080, fps: 50 }],
            },
          },
        ],
      }),
    ]);

    await expect(
      validateOutputFormat(
        "video_hdmi",
        { output1Id: "disp-out-1" },
        { width: 1920, height: 1080, fps: 50 }
      )
    ).resolves.toBeUndefined();
  });

  it("throws when DeckLink returns no modes", async () => {
    mockGetDevices.mockResolvedValue([
      makeDecklinkDevice({
        ports: [{ id: "p1", type: "sdi", status: { available: true } }],
      }),
    ]);
    mockListDecklinkDisplayModes.mockResolvedValue([]);

    await expect(
      validateOutputFormat(
        "video_sdi",
        { output1Id: "p1" },
        { width: 1920, height: 1080, fps: 50 }
      )
    ).rejects.toThrow("Output format not supported by selected device");
  });

  it("throws when DeckLink modes do not support preferred pixel format", async () => {
    mockGetDevices.mockResolvedValue([
      makeDecklinkDevice({
        ports: [{ id: "p1", type: "sdi", status: { available: true } }],
      }),
    ]);
    mockListDecklinkDisplayModes.mockResolvedValue([
      { pixelFormats: ["8bit_rgb"] },
    ]);

    await expect(
      validateOutputFormat(
        "video_sdi",
        { output1Id: "p1" },
        { width: 1920, height: 1080, fps: 50 }
      )
    ).rejects.toThrow("Output pixel format not supported by selected device");
  });

  it("resolves when DeckLink returns supported pixel format", async () => {
    mockGetDevices.mockResolvedValue([
      makeDecklinkDevice({
        ports: [{ id: "p1", type: "sdi", status: { available: true } }],
      }),
    ]);
    mockListDecklinkDisplayModes.mockResolvedValue([
      { pixelFormats: ["10bit_yuv", "8bit_yuv"] },
    ]);

    await expect(
      validateOutputFormat(
        "video_sdi",
        { output1Id: "p1" },
        { width: 1920, height: 1080, fps: 50 }
      )
    ).resolves.toBeUndefined();
  });
});
