import type {
  GraphicsBackgroundModeT,
  GraphicsOutputKeyT,
} from "./graphics-schemas.js";

/**
 * Output keys whose downstream consumer reads the alpha channel.
 *
 * For these the empty picture is a transparent frame: key/fill carries the key
 * in alpha, the browser input composites in a browser, and the meeting planes
 * ("framebus") are alpha-blended over the camera by the native compositor.
 * Filling those with an opaque colour would cover the camera picture.
 */
const ALPHA_OUTPUT_KEYS: readonly GraphicsOutputKeyT[] = [
  "stub",
  "framebus",
  "browser_input",
  "key_fill_sdi",
  "key_fill_ndi",
];

/**
 * Background for outputs that carry no alpha downstream.
 *
 * HDMI/SDI video outputs are keyed by the switcher on a colour, so the empty
 * picture must BE that colour. Black cannot be keyed by a chroma keyer, which
 * is why an empty frame used to go to air as a black box.
 */
const DEFAULT_OPAQUE_BACKGROUND_MODE: GraphicsBackgroundModeT = "green";

const BACKGROUND_MODES: readonly GraphicsBackgroundModeT[] = [
  "transparent",
  "green",
  "black",
  "white",
];

/**
 * Environment override for the opaque background colour (escape hatch for a
 * setup that keys on something other than green, until the output config
 * carries the colour itself).
 */
export const IDLE_BACKGROUND_ENV = "BRIDGE_GRAPHICS_IDLE_BACKGROUND";

/**
 * Resolve the session background mode for an output.
 *
 * The session background is what the renderer page shows while no layer is
 * live, and therefore what the empty FrameBus frame must contain.
 *
 * @param outputKey Active graphics output key.
 * @param envValue Optional raw override value (defaults to the environment).
 * @returns Background mode for the renderer session.
 */
export function resolveSessionBackgroundMode(
  outputKey: GraphicsOutputKeyT | null | undefined,
  envValue: string | undefined = process.env[IDLE_BACKGROUND_ENV],
): GraphicsBackgroundModeT {
  if (!outputKey || ALPHA_OUTPUT_KEYS.includes(outputKey)) {
    return "transparent";
  }

  const normalized = envValue?.trim().toLowerCase();
  if (
    normalized &&
    (BACKGROUND_MODES as readonly string[]).includes(normalized)
  ) {
    return normalized as GraphicsBackgroundModeT;
  }

  return DEFAULT_OPAQUE_BACKGROUND_MODE;
}
