import { RendererConfigureSchema } from "./renderer-config-schema.js";

describe("RendererConfigureSchema", () => {
  const validPayload = {
    width: 1920,
    height: 1080,
    fps: 60,
    pixelFormat: 1,
  };

  it("parses valid minimal payload with defaults", () => {
    const result = RendererConfigureSchema.parse(validPayload);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.fps).toBe(60);
    expect(result.pixelFormat).toBe(1);
    expect(result.framebusName).toBe("");
    expect(result.framebusSlotCount).toBe(0);
    expect(result.framebusSize).toBe(0);
    expect(result.backgroundMode).toBe("transparent");
  });

  it("accepts optional framebus and background options", () => {
    const result = RendererConfigureSchema.parse({
      ...validPayload,
      framebusName: "test-bus",
      framebusSlotCount: 2,
      framebusSize: 1024,
      backgroundMode: "black",
    });
    expect(result.framebusName).toBe("test-bus");
    expect(result.framebusSlotCount).toBe(2);
    expect(result.framebusSize).toBe(1024);
    expect(result.backgroundMode).toBe("black");
  });

  it("accepts valid clearColor", () => {
    const result = RendererConfigureSchema.parse({
      ...validPayload,
      clearColor: { r: 0, g: 128, b: 255, a: 1 },
    });
    expect(result.clearColor).toEqual({ r: 0, g: 128, b: 255, a: 1 });
  });

  it("rejects pixelFormat other than 1 (RGBA8)", () => {
    expect(() =>
      RendererConfigureSchema.parse({ ...validPayload, pixelFormat: 2 })
    ).toThrow(/pixelFormat must be RGBA8/);
  });

  it("rejects width exceeding MAX_FRAME_DIMENSION (8192)", () => {
    expect(() =>
      RendererConfigureSchema.parse({ ...validPayload, width: 8193 })
    ).toThrow();
  });

  it("rejects non-positive dimensions", () => {
    expect(() =>
      RendererConfigureSchema.parse({ ...validPayload, width: 0 })
    ).toThrow();
    expect(() =>
      RendererConfigureSchema.parse({ ...validPayload, height: -1 })
    ).toThrow();
  });

  it("rejects invalid backgroundMode", () => {
    expect(() =>
      RendererConfigureSchema.parse({
        ...validPayload,
        backgroundMode: "invalid",
      })
    ).toThrow();
  });

  it("rejects clearColor with out-of-range values", () => {
    expect(() =>
      RendererConfigureSchema.parse({
        ...validPayload,
        clearColor: { r: 256, g: 0, b: 0, a: 1 },
      })
    ).toThrow();
    expect(() =>
      RendererConfigureSchema.parse({
        ...validPayload,
        clearColor: { r: 0, g: 0, b: 0, a: 1.5 },
      })
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      RendererConfigureSchema.parse({ ...validPayload, unknownKey: true })
    ).toThrow();
  });
});
