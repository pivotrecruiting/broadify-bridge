import {
  InvalidHeaderError,
  FrameSizeError,
  OpenError,
} from "./framebus-errors.js";

describe("framebus-errors", () => {
  describe("InvalidHeaderError", () => {
    it("extends Error with correct name and message", () => {
      const err = new InvalidHeaderError("Invalid FrameBus header");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("InvalidHeaderError");
      expect(err.message).toBe("Invalid FrameBus header");
    });
  });

  describe("FrameSizeError", () => {
    it("extends Error with correct name and message", () => {
      const err = new FrameSizeError("Frame size mismatch");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("FrameSizeError");
      expect(err.message).toBe("Frame size mismatch");
    });
  });

  describe("OpenError", () => {
    it("extends Error with correct name and message", () => {
      const err = new OpenError("openReader failed");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("OpenError");
      expect(err.message).toBe("openReader failed");
    });
  });
});
