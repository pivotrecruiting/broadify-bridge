/**
 * Build the shared layer layout runtime used by all HTML-based graphics hosts.
 *
 * `resolveLayerCanvas` and `applyLayout` belong together: the canvas is the box
 * of a layer (its host and the `#graphic-root` container inside it) BEFORE the
 * layout transform, in plane pixels at render scale 1. `applyLayout` then
 * positions that box, and it is the only place the render scale enters - it
 * multiplies translation and scale, so the box itself is never multiplied.
 * That is how the fixed 1920x1080 box has always been treated; a per-layer
 * canvas only replaces its size.
 *
 * @returns Browser-side JavaScript defining `resolveLayerCanvas` and
 * `applyLayout`.
 */
export function getApplyLayoutRuntimeScript(renderScale = 1): string {
  return `
      const GRAPHICS_RENDER_SCALE = ${JSON.stringify(renderScale)};
      const resolveLayerCanvas = (canvas, baseWidth, baseHeight) => {
        const width = Number(canvas?.width);
        const height = Number(canvas?.height);
        if (
          Number.isFinite(width) && width > 0 &&
          Number.isFinite(height) && height > 0
        ) {
          return { width, height };
        }
        return { width: baseWidth, height: baseHeight };
      };
      const applyLayout = (host, layout) => {
        if (!host) return;
        const x = Number(layout?.x || 0) * GRAPHICS_RENDER_SCALE;
        const y = Number(layout?.y || 0) * GRAPHICS_RENDER_SCALE;
        const scale = Number(layout?.scale || 1);
        const scaleX = Number(layout?.scaleX || scale) * GRAPHICS_RENDER_SCALE;
        const scaleY = Number(layout?.scaleY || scale) * GRAPHICS_RENDER_SCALE;
        const rotationX = Number(layout?.rotationX || 0);
        const rotationY = Number(layout?.rotationY || 0);
        const rotationZ = Number(layout?.rotationZ || 0);
        host.style.transform =
          "translate3d(" + x + "px, " + y + "px, 0) " +
          "scale(" + scaleX + ", " + scaleY + ") " +
          "rotateX(" + rotationX + "deg) " +
          "rotateY(" + rotationY + "deg) " +
          "rotateZ(" + rotationZ + "deg) " +
          "translateZ(0)";
        host.style.transformStyle = "preserve-3d";
        host.style.backfaceVisibility = "hidden";
        host.style.willChange = "transform";
        host.style.imageRendering = "auto";
      };`;
}
