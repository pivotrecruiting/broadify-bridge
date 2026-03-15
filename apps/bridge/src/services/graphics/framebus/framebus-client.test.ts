import {
  InvalidHeaderError,
  FrameSizeError,
  OpenError,
} from "./framebus-errors.js";

describe("framebus-client", () => {
  describe("error classes", () => {
    it("InvalidHeaderError has correct name", () => {
      const err = new InvalidHeaderError("bad header");
      expect(err.name).toBe("InvalidHeaderError");
      expect(err.message).toBe("bad header");
    });

    it("FrameSizeError has correct name", () => {
      const err = new FrameSizeError("size mismatch");
      expect(err.name).toBe("FrameSizeError");
      expect(err.message).toBe("size mismatch");
    });

    it("OpenError has correct name", () => {
      const err = new OpenError("open failed");
      expect(err.name).toBe("OpenError");
      expect(err.message).toBe("open failed");
    });
  });
});
