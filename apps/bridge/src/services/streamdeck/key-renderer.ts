import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { BROADIFY_MARK_DATA_URL } from "./brand-mark.js";
import { drawGlyph, resolveGlyph } from "./key-glyphs.js";
import { StreamDeckKeyStyle } from "./types.js";

const DEFAULT_BG = "#20242b";
const DEFAULT_TEXT = "#ffffff";

/** Extra render context so the renderer can pick a glyph from the bound action. */
export type KeyRenderMeta = {
  command?: string;
  payload?: Record<string, unknown>;
};

/** The Broadify mark is loaded once and reused for every key. */
let brandMarkPromise: Promise<Image | null> | null = null;
function getBrandMark(): Promise<Image | null> {
  if (!brandMarkPromise) {
    brandMarkPromise = loadImage(BROADIFY_MARK_DATA_URL).catch(() => null);
  }
  return brandMarkPromise;
}

/**
 * Renders a key into a raw RGBA buffer sized for the device: a rounded,
 * gradient "button" face with a hero icon (an explicit image, else a vector
 * glyph derived from the bound command, else the Broadify mark), a legible
 * label, and a subtle Broadify corner watermark. Uses @napi-rs/canvas, already
 * shipped for meeting media, so no new native dependency is introduced.
 */
export async function renderKeyImage(
  style: StreamDeckKeyStyle,
  width: number,
  height: number,
  meta: KeyRenderMeta = {},
): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const size = Math.min(width, height);
  const radius = Math.round(size * 0.16);
  const base = parseHex(style.bgColor) ?? parseHex(DEFAULT_BG)!;

  // Whole canvas black so the rounded corners read as "off" on the LCD.
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  const hasLabel = Boolean(style.label && style.label.trim().length > 0);
  const labelReserve = hasLabel ? Math.round(height * 0.3) : 0;

  // --- Button face: vertical gradient inside a rounded rect --------------------
  roundedRect(ctx, 0.5, 0.5, width - 1, height - 1, radius);
  const faceGrad = ctx.createLinearGradient(0, 0, 0, height);
  faceGrad.addColorStop(0, rgb(mix(base, WHITE, 0.16)));
  faceGrad.addColorStop(1, rgb(mix(base, BLACK, 0.42)));
  ctx.fillStyle = faceGrad;
  ctx.fill();

  ctx.save();
  roundedRect(ctx, 0.5, 0.5, width - 1, height - 1, radius);
  ctx.clip();

  // Top sheen for a glossy button feel.
  const sheen = ctx.createLinearGradient(0, 0, 0, height * 0.55);
  sheen.addColorStop(0, "rgba(255,255,255,0.20)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, width, height * 0.55);

  // Bottom scrim so the label stays readable over bright colours.
  if (hasLabel) {
    const scrim = ctx.createLinearGradient(0, height * 0.5, 0, height);
    scrim.addColorStop(0, "rgba(0,0,0,0)");
    scrim.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, height * 0.5, width, height * 0.5);
  }
  ctx.restore();

  // Inner hairline border for definition.
  roundedRect(ctx, 1, 1, width - 2, height - 2, radius - 1);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = Math.max(1, size * 0.02);
  ctx.stroke();

  // --- Hero: explicit image, else vector glyph, else the Broadify mark ---------
  const iconAreaH = height - labelReserve;
  const iconCx = width / 2;
  const iconCy = iconAreaH / 2 + Math.round(size * 0.02);
  const glyph = resolveGlyph(meta.command, meta.payload);
  let brandIsHero = false;

  if (style.icon) {
    try {
      const image = await loadImage(style.icon);
      fitImage(ctx, image, width, iconAreaH, labelReserve);
    } catch {
      // A bad/missing icon must never break rendering — label still shows.
    }
  } else if (glyph) {
    const glyphSize = Math.min(iconAreaH * 0.6, width * 0.5);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = size * 0.06;
    ctx.shadowOffsetY = size * 0.02;
    ctx.strokeStyle = style.textColor || DEFAULT_TEXT;
    ctx.fillStyle = style.textColor || DEFAULT_TEXT;
    drawGlyph(ctx, glyph, iconCx, iconCy, glyphSize);
    ctx.restore();
  } else {
    // No specific glyph → let the Broadify mark be the hero (brand fallback).
    const mark = await getBrandMark();
    if (mark) {
      const markSize = Math.min(iconAreaH * 0.72, width * 0.6);
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(
        mark,
        iconCx - markSize / 2,
        iconCy - markSize / 2,
        markSize,
        markSize,
      );
      ctx.restore();
      brandIsHero = true;
    }
  }

  // --- Broadify corner watermark (skipped when the mark is already the hero) ---
  if (!brandIsHero) {
    const mark = await getBrandMark();
    if (mark) {
      const wm = Math.max(14, Math.round(width * 0.17));
      const margin = Math.round(size * 0.06);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.drawImage(mark, width - wm - margin, margin, wm, wm);
      ctx.restore();
    }
  }

  // --- Label: wrapped to two lines, sitting in the reserved bottom band --------
  if (hasLabel) {
    ctx.fillStyle = style.textColor || DEFAULT_TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontSize = Math.max(10, Math.round(height * 0.16));
    ctx.font = `600 ${fontSize}px sans-serif`;
    const lines = wrapText(ctx, style.label ?? "", width - 10, 2);
    const lineHeight = fontSize * 1.15;
    const blockH = lines.length * lineHeight;
    const baseY = height - labelReserve / 2 - blockH / 2 + lineHeight / 2;
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = size * 0.03;
    lines.forEach((line, i) => {
      ctx.fillText(line, width / 2, baseY + i * lineHeight);
    });
  }

  const image = ctx.getImageData(0, 0, width, height);
  return Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
}

/** Draws an image fit into the icon area above the label band. */
function fitImage(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  image: Image,
  width: number,
  iconAreaH: number,
  labelReserve: number,
): void {
  const boxH = iconAreaH - 8;
  const boxW = width - 12;
  const scale = Math.min(boxW / image.width, boxH / image.height, 1);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const x = (width - drawW) / 2;
  const y = (iconAreaH - drawH) / 2;
  void labelReserve;
  ctx.drawImage(image, x, y, drawW, drawH);
}

// --- Colour helpers ----------------------------------------------------------

type Rgb = { r: number; g: number; b: number };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function parseHex(value: string | undefined): Rgb | null {
  if (!value) {
    return null;
  }
  let hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** Linear blend from `a` toward `b` by `t` (0..1). */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function rgb(c: Rgb): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function roundedRect(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Greedy word-wrap capped at maxLines; the last line is ellipsized if needed. */
function wrapText(
  ctx: { measureText: (t: string) => { width: number } },
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || current === "") {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        break;
      }
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    if (ctx.measureText(last).width > maxWidth || words.join(" ") !== lines.join(" ")) {
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines.length > 0 ? lines : [""];
}
