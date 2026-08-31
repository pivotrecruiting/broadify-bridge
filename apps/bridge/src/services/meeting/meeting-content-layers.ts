/**
 * Builders for bridge-internal meeting content layers (video files and
 * browser sources) rendered on the meeting BACK graphics plane.
 *
 * The HTML produced here bypasses the customer-template sanitizer (it is
 * bridge-authored, never user HTML), so every interpolated value must be
 * escaped or come from an already-validated source.
 */

export const MEETING_CONTENT_VIDEO_LAYER_ID = "meeting-content-video";
export const MEETING_BROWSER_SOURCE_LAYER_ID = "meeting-browser-source";

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

export type MeetingContentGeometryT = {
  mode: "pip" | "fullscreen";
  /** Fractions of the 1920x1080 stage (0..1). Ignored for fullscreen. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Z rotation in degrees. */
  rotation: number;
  /** 3D tilt in degrees (the builder's news style tilts around Y). */
  rotationX?: number;
  rotationY?: number;
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const containerStyle = (geometry: MeetingContentGeometryT): string => {
  if (geometry.mode === "fullscreen") {
    return `position:absolute;left:0;top:0;width:${STAGE_WIDTH}px;height:${STAGE_HEIGHT}px;`;
  }
  const left = Math.round(clamp01(geometry.x) * STAGE_WIDTH);
  const top = Math.round(clamp01(geometry.y) * STAGE_HEIGHT);
  const width = Math.max(1, Math.round(clamp01(geometry.width) * STAGE_WIDTH));
  const height = Math.max(1, Math.round(clamp01(geometry.height) * STAGE_HEIGHT));
  const safeDeg = (value: number | undefined): number =>
    Number.isFinite(value) ? (value as number) : 0;
  const rotation = safeDeg(geometry.rotation);
  const rotationX = safeDeg(geometry.rotationX);
  const rotationY = safeDeg(geometry.rotationY);
  // perspective() makes the X/Y tilt actually look 3D (news style) - without
  // it rotateY renders as a flat horizontal squeeze.
  return (
    `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;` +
    `transform:perspective(1200px) rotateX(${rotationX}deg) rotateY(${rotationY}deg) rotate(${rotation}deg);` +
    `transform-origin:center center;`
  );
};

/**
 * Builds the HTML for the internal video content layer.
 *
 * @param videoUrl Local bridge URL of the video asset (already validated).
 * @param geometry Placement on the 1920x1080 stage.
 * @param options Playback options.
 * @returns Layer HTML.
 */
export function buildVideoLayerHtml(
  videoUrl: string,
  geometry: MeetingContentGeometryT,
  options: { muted: boolean; loop: boolean },
): string {
  const attributes = [
    `src="${escapeHtmlAttribute(videoUrl)}"`,
    "autoplay",
    "playsinline",
    options.loop ? "loop" : null,
    options.muted ? "muted" : null,
  ]
    .filter((attribute): attribute is string => attribute !== null)
    .join(" ");
  return (
    `<div style="${containerStyle(geometry)}">` +
    `<video ${attributes} style="width:100%;height:100%;object-fit:contain;"></video>` +
    `</div>`
  );
}

/**
 * Builds the HTML for the internal browser source layer.
 *
 * @param url External HTTPS URL (validated via validateBrowserSourceUrl).
 * @param geometry Placement on the 1920x1080 stage.
 * @returns Layer HTML.
 */
export function buildBrowserSourceLayerHtml(
  url: string,
  geometry: MeetingContentGeometryT,
): string {
  return (
    `<div style="${containerStyle(geometry)}">` +
    `<iframe src="${escapeHtmlAttribute(url)}" allow="autoplay"` +
    ` style="width:100%;height:100%;border:0;background:transparent;"></iframe>` +
    `</div>`
  );
}

/**
 * Validates a browser source URL: HTTPS only, no embedded credentials.
 * Chromium loads the page directly, so server-side SSRF guards do not apply -
 * this narrows the surface to public HTTPS content.
 *
 * @param rawUrl URL supplied by the webapp.
 * @returns Normalized URL string.
 */
export function validateBrowserSourceUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Browser source URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Browser source URLs must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Browser source URLs must not contain credentials.");
  }
  return parsed.toString();
}
