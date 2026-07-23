import type { SKRSContext2D } from "@napi-rs/canvas";

/**
 * Monochrome vector glyphs drawn directly on the canvas — no image assets, so
 * they stay crisp at any key size (72px legacy decks → 120px Stream Deck +).
 * The bridge derives the glyph from a key's bound relay `command` (+ payload),
 * so existing saved mappings get icons too, with no webapp change.
 */
export type GlyphId =
  | "mic"
  | "speaker"
  | "hangup"
  | "camera"
  | "camera-off"
  | "pip"
  | "pip-off"
  | "background"
  | "logo"
  | "person"
  | "content-pip"
  | "content-full"
  | "chevron-left"
  | "chevron-right"
  | "macro"
  | "vmix"
  | "ptz"
  | "graphics"
  | "director"
  | "monitor";

/** Maps a bound relay command (+ payload) to the glyph that best represents it. */
export function resolveGlyph(
  command: string | undefined,
  payload: Record<string, unknown> | undefined,
): GlyphId | null {
  if (!command) {
    return null;
  }
  const feature = typeof payload?.feature === "string" ? payload.feature : "";
  const action = typeof payload?.action === "string" ? payload.action : "";
  const mode = typeof payload?.mode === "string" ? payload.mode : "";
  const delta = typeof payload?.delta === "number" ? payload.delta : 0;
  const cameraIndex =
    typeof payload?.camera_index === "number" ? payload.camera_index : 0;

  switch (command) {
    case "meeting_call_control":
      if (action === "mic_toggle") return "mic";
      if (action === "speaker_toggle") return "speaker";
      if (action === "hangup") return "hangup";
      return "mic";
    case "meeting_camera_program_select":
      return "camera";
    case "meeting_camera_pip_set":
      return cameraIndex < 0 ? "pip-off" : "pip";
    case "meeting_camera_start":
      return "camera";
    case "meeting_camera_stop":
      return "camera-off";
    case "webapp:meeting_toggle":
      if (feature === "camera") return "camera";
      if (feature === "background") return "background";
      if (feature === "logo") return "logo";
      if (feature === "speakerLayout") return "person";
      return "person";
    case "webapp:meeting_content_mode":
      return mode === "fullscreen" ? "content-full" : "content-pip";
    case "webapp:meeting_content_page":
      return delta < 0 ? "chevron-left" : "chevron-right";
    case "webapp:graphics_preset":
      return "graphics";
    case "engine_run_macro":
      return "macro";
    case "engine_vmix_run_action":
      return "vmix";
    case "canon_xc_recall_preset":
      return "ptz";
    case "conference_director_start":
    case "conference_director_stop":
      return "director";
    case "conference_display_start":
    case "conference_display_stop":
      return "monitor";
    case "streamdeck:page_next":
      return "chevron-right";
    case "streamdeck:page_prev":
      return "chevron-left";
    default:
      return null;
  }
}

/**
 * Draws the glyph centred at (cx, cy) filling roughly a `size`×`size` box. The
 * caller sets the colour; strokes and fills both use the current style.
 */
export function drawGlyph(
  ctx: SKRSContext2D,
  id: GlyphId,
  cx: number,
  cy: number,
  size: number,
): void {
  const lw = Math.max(2, size * 0.085);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Fractional helpers: coordinates are in [-0.5, 0.5] of `size`.
  const px = (f: number) => f * size;

  switch (id) {
    case "mic": {
      roundedRectPath(ctx, px(-0.13), px(-0.42), px(0.26), px(0.42), px(0.13));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, px(-0.06), px(0.26), 0, Math.PI);
      ctx.stroke();
      line(ctx, 0, px(0.2), 0, px(0.4));
      line(ctx, px(-0.14), px(0.4), px(0.14), px(0.4));
      break;
    }
    case "speaker": {
      ctx.beginPath();
      ctx.moveTo(px(-0.36), px(-0.13));
      ctx.lineTo(px(-0.16), px(-0.13));
      ctx.lineTo(px(0.02), px(-0.32));
      ctx.lineTo(px(0.02), px(0.32));
      ctx.lineTo(px(-0.16), px(0.13));
      ctx.lineTo(px(-0.36), px(0.13));
      ctx.closePath();
      ctx.stroke();
      arc(ctx, px(0.04), 0, px(0.16), -0.4 * Math.PI, 0.4 * Math.PI);
      arc(ctx, px(0.04), 0, px(0.3), -0.4 * Math.PI, 0.4 * Math.PI);
      break;
    }
    case "hangup": {
      // A filled handset (crescent body + ear/mouth bulbs), tilted like the
      // classic "end call" icon.
      ctx.save();
      ctx.rotate(Math.PI * 0.75);
      const R = px(0.42);
      const r = px(0.22);
      const cy = px(0.26);
      const a0 = Math.PI * 1.16;
      const a1 = Math.PI * 1.84;
      ctx.beginPath();
      ctx.arc(0, cy, R, a0, a1, false);
      ctx.arc(0, cy, r, a1, a0, true);
      ctx.closePath();
      ctx.fill();
      const mr = (R + r) / 2;
      for (const a of [a0, a1]) {
        dot(ctx, Math.cos(a) * mr, cy + Math.sin(a) * mr, px(0.14), true);
      }
      ctx.restore();
      break;
    }
    case "camera":
    case "camera-off": {
      roundedRectPath(ctx, px(-0.42), px(-0.18), px(0.56), px(0.36), px(0.07));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(0.14), px(-0.08));
      ctx.lineTo(px(0.42), px(-0.22));
      ctx.lineTo(px(0.42), px(0.22));
      ctx.lineTo(px(0.14), px(0.08));
      ctx.closePath();
      ctx.stroke();
      if (id === "camera-off") {
        slash(ctx, size);
      }
      break;
    }
    case "pip":
    case "pip-off": {
      roundedRectPath(ctx, px(-0.42), px(-0.3), px(0.84), px(0.6), px(0.07));
      ctx.stroke();
      if (id === "pip") {
        roundedRectPath(ctx, px(0.06), px(0.02), px(0.3), px(0.22), px(0.04));
        ctx.fill();
      } else {
        slash(ctx, size);
      }
      break;
    }
    case "background": {
      roundedRectPath(ctx, px(-0.4), px(-0.32), px(0.8), px(0.64), px(0.06));
      ctx.stroke();
      dot(ctx, px(-0.16), px(-0.12), px(0.06));
      ctx.beginPath();
      ctx.moveTo(px(-0.4), px(0.24));
      ctx.lineTo(px(-0.12), px(-0.02));
      ctx.lineTo(px(0.06), px(0.16));
      ctx.lineTo(px(0.22), px(0.0));
      ctx.lineTo(px(0.4), px(0.2));
      ctx.stroke();
      break;
    }
    case "logo": {
      star(ctx, 0, 0, px(0.4), px(0.17), 5);
      ctx.stroke();
      break;
    }
    case "person": {
      dot(ctx, 0, px(-0.2), px(0.14), true);
      ctx.beginPath();
      ctx.moveTo(px(-0.3), px(0.36));
      ctx.lineTo(px(-0.3), px(0.2));
      ctx.quadraticCurveTo(px(-0.3), px(0.02), 0, px(0.02));
      ctx.quadraticCurveTo(px(0.3), px(0.02), px(0.3), px(0.2));
      ctx.lineTo(px(0.3), px(0.36));
      ctx.stroke();
      break;
    }
    case "content-pip":
    case "content-full":
    case "monitor": {
      roundedRectPath(ctx, px(-0.42), px(-0.34), px(0.84), px(0.56), px(0.06));
      ctx.stroke();
      line(ctx, 0, px(0.22), 0, px(0.34));
      line(ctx, px(-0.14), px(0.34), px(0.14), px(0.34));
      if (id === "content-pip") {
        roundedRectPath(ctx, px(0.08), px(-0.06), px(0.26), px(0.18), px(0.03));
        ctx.fill();
      } else if (id === "content-full") {
        cornerBrackets(ctx, px(0.3), px(0.18), px(0.1));
      }
      break;
    }
    case "chevron-left":
    case "chevron-right": {
      const dir = id === "chevron-left" ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(px(-0.12 * dir), px(-0.3));
      ctx.lineTo(px(0.2 * dir), 0);
      ctx.lineTo(px(-0.12 * dir), px(0.3));
      ctx.stroke();
      break;
    }
    case "macro": {
      ctx.beginPath();
      ctx.moveTo(px(0.08), px(-0.42));
      ctx.lineTo(px(-0.22), px(0.06));
      ctx.lineTo(px(-0.02), px(0.06));
      ctx.lineTo(px(-0.08), px(0.42));
      ctx.lineTo(px(0.24), px(-0.08));
      ctx.lineTo(px(0.04), px(-0.08));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "vmix": {
      ctx.beginPath();
      ctx.moveTo(px(-0.18), px(-0.28));
      ctx.lineTo(px(0.3), 0);
      ctx.lineTo(px(-0.18), px(0.28));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "ptz": {
      arc(ctx, 0, 0, px(0.32), 0, Math.PI * 2);
      line(ctx, 0, px(-0.44), 0, px(-0.16));
      line(ctx, 0, px(0.16), 0, px(0.44));
      line(ctx, px(-0.44), 0, px(-0.16), 0);
      line(ctx, px(0.16), 0, px(0.44), 0);
      dot(ctx, 0, 0, px(0.06), true);
      break;
    }
    case "graphics": {
      ctx.beginPath();
      ctx.moveTo(0, px(-0.32));
      ctx.lineTo(px(0.36), px(-0.08));
      ctx.lineTo(0, px(0.16));
      ctx.lineTo(px(-0.36), px(-0.08));
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(-0.36), px(0.1));
      ctx.lineTo(0, px(0.34));
      ctx.lineTo(px(0.36), px(0.1));
      ctx.stroke();
      break;
    }
    case "director": {
      line(ctx, px(-0.3), px(0.3), px(0.16), px(-0.16));
      star(ctx, px(0.24), px(-0.26), px(0.12), px(0.05), 4);
      ctx.fill();
      dot(ctx, px(-0.28), px(-0.24), px(0.035), true);
      dot(ctx, px(0.02), px(0.28), px(0.035), true);
      break;
    }
    default:
      break;
  }

  ctx.restore();
}

function line(
  ctx: SKRSContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function arc(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  r: number,
  start: number,
  end: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, start, end);
  ctx.stroke();
}

function dot(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  r: number,
  fill = false,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

function roundedRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function star(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function slash(ctx: SKRSContext2D, size: number): void {
  const f = 0.46 * size;
  line(ctx, -f, -f, f, f);
}

function cornerBrackets(
  ctx: SKRSContext2D,
  ext: number,
  reach: number,
  len: number,
): void {
  const corners: Array<[number, number]> = [
    [-ext, -reach],
    [ext, -reach],
    [-ext, reach],
    [ext, reach],
  ];
  for (const [x, y] of corners) {
    const sx = Math.sign(x);
    const sy = Math.sign(y);
    line(ctx, x, y, x - sx * len, y);
    line(ctx, x, y, x, y - sy * len);
  }
}
