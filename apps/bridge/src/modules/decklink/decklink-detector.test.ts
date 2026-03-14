jest.mock("./decklink-helper.js", () => ({
  listDecklinkDevices: jest.fn(),
  listDecklinkDisplayModes: jest.fn(),
}));

jest.mock("../../services/bridge-context.js", () => ({
  getBridgeContext: () => ({ logger: { warn: jest.fn() } }),
}));

import { parseDecklinkHelperDevices } from "./decklink-detector.js";

describe("decklink-detector", () => {
  describe("parseDecklinkHelperDevices", () => {
    it("parses valid device list", () => {
      const raw = [
        {
          id: "decklink-1",
          displayName: "DeckLink Mini Recorder",
          videoOutputConnections: ["sdi"],
          supportsExternalKeying: false,
        },
      ];
      const result = parseDecklinkHelperDevices(raw);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("decklink-1");
      expect(result[0].type).toBe("decklink");
      expect(result[0].ports).toHaveLength(1);
      expect(result[0].ports[0].id).toBe("decklink-1-sdi");
      expect(result[0].ports[0].role).toBe("video");
    });

    it("creates fill/key ports when supportsExternalKeying", () => {
      const raw = [
        {
          id: "decklink-2",
          displayName: "DeckLink Duo",
          videoOutputConnections: ["sdi"],
          supportsExternalKeying: true,
        },
      ];
      const result = parseDecklinkHelperDevices(raw);
      expect(result[0].ports).toHaveLength(2);
      expect(result[0].ports[0].id).toBe("decklink-2-sdi-a");
      expect(result[0].ports[0].role).toBe("fill");
      expect(result[0].ports[1].id).toBe("decklink-2-sdi-b");
      expect(result[0].ports[1].role).toBe("key");
    });

    it("includes HDMI port when videoOutputConnections has hdmi", () => {
      const raw = [
        {
          id: "decklink-3",
          displayName: "DeckLink HDMI",
          videoOutputConnections: ["hdmi"],
        },
      ];
      const result = parseDecklinkHelperDevices(raw);
      expect(result[0].ports).toHaveLength(1);
      expect(result[0].ports[0].id).toBe("decklink-3-hdmi");
      expect(result[0].ports[0].type).toBe("hdmi");
    });

    it("marks device inUse when busy is true", () => {
      const raw = [
        {
          id: "decklink-4",
          displayName: "DeckLink",
          videoOutputConnections: ["sdi"],
          busy: true,
        },
      ];
      const result = parseDecklinkHelperDevices(raw);
      expect(result[0].status.inUse).toBe(true);
      expect(result[0].status.ready).toBe(false);
    });

    it("returns empty array for invalid payload", () => {
      expect(parseDecklinkHelperDevices(null)).toEqual([]);
      expect(parseDecklinkHelperDevices("not an array")).toEqual([]);
      expect(parseDecklinkHelperDevices([{ invalid: "data" }])).toEqual([]);
    });

    it("returns empty array for empty array", () => {
      expect(parseDecklinkHelperDevices([])).toEqual([]);
    });
  });
});
