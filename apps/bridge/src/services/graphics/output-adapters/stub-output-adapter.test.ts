import { StubOutputAdapter } from "./stub-output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";

const createConfig = (): GraphicsOutputConfigT => ({
  version: 1,
  outputKey: "stub",
  targets: { output1Id: "display-1" },
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal",
  colorspace: "auto",
});

const createFrame = () => ({
  width: 1920,
  height: 1080,
  rgba: Buffer.alloc(1920 * 1080 * 4),
  timestamp: Date.now(),
});

describe("StubOutputAdapter", () => {
  const originalEnv = process.env.BRIDGE_LOG_STUB_OUTPUT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BRIDGE_LOG_STUB_OUTPUT = originalEnv;
    } else {
      delete process.env.BRIDGE_LOG_STUB_OUTPUT;
    }
  });

  it("configures and accepts frames", async () => {
    const adapter = new StubOutputAdapter();
    const config = createConfig();
    await adapter.configure(config);
    await adapter.sendFrame(createFrame(), config);
    await adapter.stop();
  });

  it("ignores sendFrame when not configured", async () => {
    const adapter = new StubOutputAdapter();
    await adapter.sendFrame(createFrame(), createConfig());
    await adapter.stop();
  });

  it("stop resets configured state", async () => {
    const adapter = new StubOutputAdapter();
    await adapter.configure(createConfig());
    await adapter.stop();
    await adapter.sendFrame(createFrame(), createConfig());
  });

  it("logs configure message when BRIDGE_LOG_STUB_OUTPUT=1", async () => {
    process.env.BRIDGE_LOG_STUB_OUTPUT = "1";
    const consoleSpy = jest.spyOn(console, "log").mockImplementation();
    const adapter = new StubOutputAdapter();
    await adapter.configure(createConfig());
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Configured output: stub")
    );
    consoleSpy.mockRestore();
  });
});
