import { createCanvas, loadImage } from "@napi-rs/canvas";
import { StreamDeckKeyStyle } from "./types.js";

const DEFAULT_BG = "#20242b";
const DEFAULT_TEXT = "#ffffff";

/**
 * Renders a key's style (background colour, optional icon, wrapped label) into a
 * raw RGBA buffer sized for the device. Uses @napi-rs/canvas, which the bridge
 * already ships for meeting media, so no new native dependency is introduced.
 */
export async function renderKeyImage(
  style: StreamDeckKeyStyle,
  width: number,
  height: number,
): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Background.
  ctx.fillStyle = style.bgColor || DEFAULT_BG;
  ctx.fillRect(0, 0, width, height);

  const hasLabel = Boolean(style.label && style.label.trim().length > 0);
  const labelReserve = hasLabel ? Math.round(height * 0.32) : 0;

  // Icon (optional), centred in the space above the label.
  if (style.icon) {
    try {
      const image = await loadImage(style.icon);
      const boxH = height - labelReserve - 8;
      const boxW = width - 12;
      const scale = Math.min(boxW / image.width, boxH / image.height, 1);
      const drawW = image.width * scale;
      const drawH = image.height * scale;
      const x = (width - drawW) / 2;
      const y = (height - labelReserve - drawH) / 2;
      ctx.drawImage(image, x, y, drawW, drawH);
    } catch {
      // A bad/missing icon must never break rendering — label still shows.
    }
  }

  // Label, wrapped to at most two lines, bottom-aligned.
  if (hasLabel) {
    ctx.fillStyle = style.textColor || DEFAULT_TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontSize = Math.max(10, Math.round(height * 0.16));
    ctx.font = `600 ${fontSize}px sans-serif`;
    const lines = wrapText(ctx, style.label ?? "", width - 8, 2);
    const lineHeight = fontSize * 1.15;
    const blockH = lines.length * lineHeight;
    // Sit the label block in the reserved bottom band.
    const baseY = height - labelReserve / 2 - blockH / 2 + lineHeight / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, width / 2, baseY + i * lineHeight);
    });
  }

  const image = ctx.getImageData(0, 0, width, height);
  return Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
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
  // Ellipsize the final line if the text overflowed.
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
