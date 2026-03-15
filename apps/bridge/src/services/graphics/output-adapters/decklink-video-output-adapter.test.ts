import { DecklinkVideoOutputAdapter } from "./decklink-video-output-adapter.js";

jest.mock("../../../modules/decklink/decklink-helper.js", () => ({
  resolveDecklinkHelperPath: () => "/tmp/decklink-helper",
}));

jest.mock("node:fs/promises", () => ({
  access: jest.fn().mockResolvedValue(undefined),
}));

const baseConfig = {
  outputKey: "video_sdi" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

describe("DecklinkVideoOutputAdapter", () => {
  let adapter: DecklinkVideoOutputAdapter;

  beforeEach(() => {
    adapter = new DecklinkVideoOutputAdapter();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  describe("configure", () => {
    it("throws when output1Id is missing", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: {},
        })
      ).rejects.toThrow("Missing output port for DeckLink video output");
    });

    it("throws when port ID is invalid", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "invalid-port" },
        })
      ).rejects.toThrow("Invalid DeckLink port ID for video output");
    });

    it("throws when port is key-only", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi-b" },
        })
      ).rejects.toThrow("Output port must be a video-capable port");
    });
  });
});
