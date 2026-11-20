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

/** Size of the meeting graphics plane the layer is placed on, in pixels. */
export type MeetingContentStageSizeT = { width: number; height: number };

/** Landscape stage; a portrait program passes its own plane size instead. */
export const DEFAULT_MEETING_CONTENT_STAGE_SIZE: MeetingContentStageSizeT = {
  width: 1920,
  height: 1080,
};

export type MeetingContentGeometryT = {
  mode: "pip" | "fullscreen";
  /** Fractions of the stage (0..1). Ignored for fullscreen. */
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

const containerStyle = (
  geometry: MeetingContentGeometryT,
  stage: MeetingContentStageSizeT,
): string => {
  if (geometry.mode === "fullscreen") {
    return `position:absolute;left:0;top:0;width:${stage.width}px;height:${stage.height}px;`;
  }
  const left = Math.round(clamp01(geometry.x) * stage.width);
  const top = Math.round(clamp01(geometry.y) * stage.height);
  const width = Math.max(1, Math.round(clamp01(geometry.width) * stage.width));
  const height = Math.max(1, Math.round(clamp01(geometry.height) * stage.height));
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
 * @param geometry Placement on the stage.
 * @param options Playback options.
 * @param stage Stage size in plane pixels (default 1920x1080).
 * @returns Layer HTML.
 */
export function buildVideoLayerHtml(
  videoUrl: string,
  geometry: MeetingContentGeometryT,
  options: { muted: boolean; loop: boolean },
  stage: MeetingContentStageSizeT = DEFAULT_MEETING_CONTENT_STAGE_SIZE,
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
    `<div style="${containerStyle(geometry, stage)}">` +
    `<video ${attributes} style="width:100%;height:100%;object-fit:contain;"></video>` +
    `</div>`
  );
}

/**
 * Builds the HTML for the internal browser source layer.
 *
 * @param url External HTTPS URL (validated via validateBrowserSourceUrl).
 * @param geometry Placement on the stage.
 * @param stage Stage size in plane pixels (default 1920x1080).
 * @returns Layer HTML.
 */
export function buildBrowserSourceLayerHtml(
  url: string,
  geometry: MeetingContentGeometryT,
  stage: MeetingContentStageSizeT = DEFAULT_MEETING_CONTENT_STAGE_SIZE,
): string {
  return (
    `<div style="${containerStyle(geometry, stage)}">` +
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
