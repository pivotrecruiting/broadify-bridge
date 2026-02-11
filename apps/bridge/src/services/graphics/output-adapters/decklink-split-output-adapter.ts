import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import { DecklinkVideoOutputAdapter } from "./decklink-video-output-adapter.js";
import { getBridgeContext } from "../../bridge-context.js";

const ALPHA_MAX = 255;

const clampByte = (value: number): number => {
  if (value <= 0) {
    return 0;
  }
  if (value >= ALPHA_MAX) {
    return ALPHA_MAX;
  }
  return value;
};

const getLogger = () => {
  try {
    return getBridgeContext().logger;
  } catch {
    return console;
  }
};

const splitFillAndKey = (rgba: Buffer): { fill: Buffer; key: Buffer } => {
  const fill = Buffer.alloc(rgba.length);
  const key = Buffer.alloc(rgba.length);

  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    let r = rgba[i];
    let g = rgba[i + 1];
    let b = rgba[i + 2];

    if (alpha > 0 && alpha < ALPHA_MAX) {
      const scale = ALPHA_MAX / alpha;
      r = clampByte(Math.round(r * scale));
      g = clampByte(Math.round(g * scale));
      b = clampByte(Math.round(b * scale));
    } else if (alpha === 0) {
      r = 0;
      g = 0;
      b = 0;
    }

    fill[i] = r;
    fill[i + 1] = g;
    fill[i + 2] = b;
    fill[i + 3] = ALPHA_MAX;

    key[i] = alpha;
    key[i + 1] = alpha;
    key[i + 2] = alpha;
    key[i + 3] = ALPHA_MAX;
  }

  return { fill, key };
};

const buildSplitConfig = (
  config: GraphicsOutputConfigT,
  outputId: string
): GraphicsOutputConfigT => ({
  ...config,
  targets: {
    ...config.targets,
    output1Id: outputId,
    output2Id: undefined,
  },
});

/**
 * DeckLink output adapter for software-split key/fill (two independent outputs).
 *
 * Splits alpha into a separate key frame and sends both frames to two helpers.
 */
export class DecklinkSplitOutputAdapter implements GraphicsOutputAdapter {
  // Split key/fill uses the legacy stdin path only (no FrameBus support).
  private fillAdapter = new DecklinkVideoOutputAdapter({ useFrameBus: false });
  private keyAdapter = new DecklinkVideoOutputAdapter({ useFrameBus: false });
  private configured = false;

  /**
   * Configure both fill and key helper processes.
   *
   * @param config Output configuration payload (validated upstream).
   */
  async configure(config: GraphicsOutputConfigT): Promise<void> {
    await this.stop();

    const output1Id = config.targets.output1Id;
    const output2Id = config.targets.output2Id;
    if (!output1Id || !output2Id) {
      throw new Error("Missing output ports for DeckLink split key/fill");
    }

    const fillConfig = buildSplitConfig(config, output1Id);
    const keyConfig = buildSplitConfig(config, output2Id);

    await this.fillAdapter.configure(fillConfig);
    try {
      await this.keyAdapter.configure(keyConfig);
    } catch (error) {
      await this.fillAdapter.stop();
      throw error;
    }

    this.configured = true;
  }

  /**
   * Send a single RGBA frame to both fill and key helpers.
   *
   * @param frame RGBA frame buffer with width/height metadata.
   * @param config Output configuration payload.
   */
  async sendFrame(
    frame: GraphicsOutputFrameT,
    config: GraphicsOutputConfigT
  ): Promise<void> {
    if (!this.configured) {
      getLogger().warn("[DeckLinkSplit] Adapter not configured");
      return;
    }
    if (!config.targets.output1Id || !config.targets.output2Id) {
      getLogger().warn("[DeckLinkSplit] Missing output targets");
      return;
    }

    const { fill, key } = splitFillAndKey(frame.rgba);
    const fillFrame: GraphicsOutputFrameT = {
      ...frame,
      rgba: fill,
    };
    const keyFrame: GraphicsOutputFrameT = {
      ...frame,
      rgba: key,
    };

    const fillConfig = buildSplitConfig(config, config.targets.output1Id);
    const keyConfig = buildSplitConfig(config, config.targets.output2Id);

    await this.fillAdapter.sendFrame(fillFrame, fillConfig);
    await this.keyAdapter.sendFrame(keyFrame, keyConfig);
  }

  /**
   * Stop both helper processes and release resources.
   */
  async stop(): Promise<void> {
    await this.fillAdapter.stop();
    await this.keyAdapter.stop();
    this.configured = false;
  }
}
