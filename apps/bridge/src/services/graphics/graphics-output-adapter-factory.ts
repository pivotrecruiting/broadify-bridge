import type { GraphicsOutputConfigT } from "./graphics-schemas.js";
import { isDevelopmentMode } from "../dev-mode.js";
import { StubOutputAdapter } from "./output-adapters/stub-output-adapter.js";
import { DecklinkKeyFillOutputAdapter } from "./output-adapters/decklink-key-fill-output-adapter.js";
import { DecklinkVideoOutputAdapter } from "./output-adapters/decklink-video-output-adapter.js";
import { DisplayVideoOutputAdapter } from "./output-adapters/display-output-adapter.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import { findCachedDevicePortById } from "./graphics-device-port-resolver.js";
import { GraphicsError } from "./graphics-errors.js";

/**
 * Select the output adapter for the active graphics output configuration.
 *
 * @param config Output configuration.
 * @returns Adapter implementation for the selected output path.
 */
export async function selectOutputAdapter(
  config: GraphicsOutputConfigT,
): Promise<GraphicsOutputAdapter> {
  if (isDevelopmentMode()) {
    return new StubOutputAdapter();
  }
  if (config.outputKey === "framebus") {
    return new StubOutputAdapter();
  }
  if (config.outputKey === "browser_input") {
    return new StubOutputAdapter();
  }
  if (config.outputKey === "key_fill_sdi") {
    return new DecklinkKeyFillOutputAdapter();
  }
  if (config.outputKey === "video_sdi") {
    return new DecklinkVideoOutputAdapter();
  }
  if (config.outputKey === "video_hdmi") {
    const outputId = config.targets.output1Id;
    const portMatch = outputId
      ? await findCachedDevicePortById(outputId)
      : null;
    if (!portMatch) {
      // No DeckLink fallback for a display target: a persisted display output
      // whose monitor is unplugged used to resolve to the DeckLink adapter,
      // whose helper does not even exist on Windows ("DeckLink helper not
      // executable", recovery attempts exhausted). The caller keeps the
      // persisted config and the output supervisor waits for the device.
      throw new GraphicsError(
        "output_device_not_found",
        `Display output ${outputId ?? "(none)"} is not connected`,
      );
    }
    if (portMatch.device.type === "display") {
      return new DisplayVideoOutputAdapter();
    }
    // An HDMI port on a DeckLink card (e.g. UltraStudio) is a DeckLink output.
    return new DecklinkVideoOutputAdapter();
  }
  return new StubOutputAdapter();
}
