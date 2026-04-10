import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "./output-adapter.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";
import { StubOutputAdapter } from "./output-adapters/stub-output-adapter.js";

describe("output-adapter", () => {
  describe("GraphicsOutputAdapter contract", () => {
    it("StubOutputAdapter implements GraphicsOutputAdapter", () => {
      const adapter: GraphicsOutputAdapter = new StubOutputAdapter();
      expect(typeof adapter.configure).toBe("function");
      expect(typeof adapter.sendFrame).toBe("function");
      expect(typeof adapter.stop).toBe("function");
    });

    it("StubOutputAdapter configure and sendFrame work", async () => {
      const adapter = new StubOutputAdapter();
      const config: GraphicsOutputConfigT = {
        version: 1,
        outputKey: "stub",
        targets: {},
        format: { width: 1920, height: 1080, fps: 30 },
        range: "legal",
        colorspace: "auto",
      };
      await adapter.configure(config);

      const frame: GraphicsOutputFrameT = {
        width: 1920,
        height: 1080,
        rgba: Buffer.alloc(1920 * 1080 * 4),
        timestamp: Date.now(),
      };
      await expect(adapter.sendFrame(frame, config)).resolves.toBeUndefined();
    });

    it("StubOutputAdapter stop is idempotent", async () => {
      const adapter = new StubOutputAdapter();
      await adapter.stop();
      await adapter.stop();
    });
  });
});
