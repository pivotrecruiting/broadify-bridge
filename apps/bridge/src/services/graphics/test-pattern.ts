import type { GraphicsSendPayloadT } from "./graphics-schemas.js";

const TEST_PATTERN_LAYER_ID = "test-pattern";
const TEST_PATTERN_HTML =
  '<div data-root="graphic" class="test-pattern"><div class="test-pattern__circle"></div></div>';
const TEST_PATTERN_CSS = `
* { box-sizing: border-box; }
.test-pattern {
  position: relative;
  width: 100%;
  height: 100%;
  background: #ff0000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.test-pattern__circle {
  width: 40vmin;
  height: 40vmin;
  background: #000000;
  border-radius: 50%;
}
`;

/**
 * Build a deterministic test pattern payload for debugging output pipelines.
 */
export function createTestPatternPayload(): GraphicsSendPayloadT {
  return {
    layerId: TEST_PATTERN_LAYER_ID,
    category: "overlays",
    backgroundMode: "transparent",
    layout: { x: 0, y: 0, scale: 1 },
    zIndex: 200,
    bundle: {
      manifest: { name: "test-pattern", version: 1 },
      html: TEST_PATTERN_HTML,
      css: TEST_PATTERN_CSS.trim(),
      schema: {},
      defaults: {},
      assets: [],
    },
    values: {},
  };
}

export { TEST_PATTERN_LAYER_ID };
