import { parseDecklinkPortId } from "./decklink-port.js";

describe("decklink-port", () => {
  describe("parseDecklinkPortId", () => {
    it("parses SDI fill port (-sdi-a)", () => {
      expect(parseDecklinkPortId("decklink-1-sdi-a")).toEqual({
        deviceId: "decklink-1",
        portType: "sdi",
        portRole: "fill",
      });
    });

    it("parses SDI key port (-sdi-b)", () => {
      expect(parseDecklinkPortId("decklink-2-sdi-b")).toEqual({
        deviceId: "decklink-2",
        portType: "sdi",
        portRole: "key",
      });
    });

    it("parses SDI video port (-sdi)", () => {
      expect(parseDecklinkPortId("decklink-3-sdi")).toEqual({
        deviceId: "decklink-3",
        portType: "sdi",
        portRole: "video",
      });
    });

    it("parses HDMI video port (-hdmi)", () => {
      expect(parseDecklinkPortId("decklink-4-hdmi")).toEqual({
        deviceId: "decklink-4",
        portType: "hdmi",
        portRole: "video",
      });
    });

    it("returns null for unrecognized format", () => {
      expect(parseDecklinkPortId("unknown")).toBeNull();
      expect(parseDecklinkPortId("decklink-1")).toBeNull();
      expect(parseDecklinkPortId("decklink-1-sdi-c")).toBeNull();
    });

    it("prefers longer suffix match (sdi-a over sdi)", () => {
      expect(parseDecklinkPortId("x-sdi-a")).toEqual({
        deviceId: "x",
        portType: "sdi",
        portRole: "fill",
      });
    });
  });
});
