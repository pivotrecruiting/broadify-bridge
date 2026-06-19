/**
 * Build the shared layer layout runtime used by all HTML-based graphics hosts.
 *
 * @returns Browser-side JavaScript defining `applyLayout`.
 */
export function getApplyLayoutRuntimeScript(renderScale = 1): string {
  return `
      const GRAPHICS_RENDER_SCALE = ${JSON.stringify(renderScale)};
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
