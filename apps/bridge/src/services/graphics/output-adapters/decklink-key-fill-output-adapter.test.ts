import { DecklinkKeyFillOutputAdapter } from "./decklink-key-fill-output-adapter.js";

jest.mock("../../../modules/decklink/decklink-helper.js", () => ({
  resolveDecklinkHelperPath: () => "/tmp/decklink-helper",
}));

jest.mock("node:fs/promises", () => ({
  access: jest.fn().mockResolvedValue(undefined),
}));

const baseConfig = {
  outputKey: "key_fill_sdi" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

describe("DecklinkKeyFillOutputAdapter", () => {
  let adapter: DecklinkKeyFillOutputAdapter;

  beforeEach(() => {
    adapter = new DecklinkKeyFillOutputAdapter();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  describe("configure", () => {
    it("throws when output1Id is missing", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output2Id: "decklink-1-sdi-b" },
        })
      ).rejects.toThrow("Missing output ports for DeckLink keyer");
    });

    it("throws when output2Id is missing", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi-a" },
        })
      ).rejects.toThrow("Missing output ports for DeckLink keyer");
    });

    it("throws when port IDs are invalid", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: {
            output1Id: "invalid",
            output2Id: "decklink-1-sdi-b",
          },
        })
      ).rejects.toThrow("Invalid DeckLink port IDs for keyer output");
    });

    it("throws when fill and key ports are from different devices", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: {
            output1Id: "decklink-1-sdi-a",
            output2Id: "decklink-2-sdi-b",
          },
        })
      ).rejects.toThrow("Fill and key ports must belong to the same device");
    });

    it("throws when ports are not a valid fill/key pair", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: {
            output1Id: "decklink-1-sdi",
            output2Id: "decklink-1-sdi-b",
          },
        })
      ).rejects.toThrow("Output ports are not a valid SDI fill/key pair");
    });
  });
});
