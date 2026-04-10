import { GraphicsError } from "./graphics-errors.js";

describe("graphics-errors", () => {
  describe("GraphicsError", () => {
    it("creates error with code and message", () => {
      const err = new GraphicsError("output_config_error", "Invalid format");
      expect(err.message).toBe("Invalid format");
      expect(err.code).toBe("output_config_error");
      expect(err.name).toBe("GraphicsError");
    });

    it("extends Error and is instanceof Error", () => {
      const err = new GraphicsError("renderer_error", "Crash");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(GraphicsError);
    });

    it("supports all error codes", () => {
      const codes = [
        "output_config_error",
        "renderer_error",
        "output_helper_error",
        "graphics_error",
      ] as const;
      for (const code of codes) {
        const err = new GraphicsError(code, "test");
        expect(err.code).toBe(code);
      }
    });
  });
});
