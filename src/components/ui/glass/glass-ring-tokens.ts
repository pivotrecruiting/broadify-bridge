export type GlassRingToneT = "primary" | "emerald";

export type GlassRingIntensityT = "subtle" | "strong";

/** Colored border + glow classes for glass ring overlays (tone × intensity). */
export const GLASS_RING_TONE_CLASSES: Record<
  GlassRingToneT,
  Record<GlassRingIntensityT, string>
> = {
  primary: {
    subtle: "border-primary/55 shadow-[0_0_14px_-5px_rgba(226,121,46,0.45)]",
    strong: "border-primary shadow-[0_0_20px_-3px_rgba(226,121,46,0.7)]",
  },
  emerald: {
    subtle: "border-emerald-500/55 shadow-[0_0_13px_-5px_rgba(16,185,129,0.4)]",
    strong: "border-emerald-500 shadow-[0_0_18px_-5px_rgba(16,185,129,0.6)]",
  },
};

/** Panel-button status rings beyond primary/emerald tone system. */
export const PANEL_STATUS_RING_CLASSES = {
  accepted:
    "border-2 border-sky-400 shadow-[0_0_18px_-3px_rgba(56,189,248,0.6)]",
  queued: "border-2 border-accent-foreground/50",
} as const;

export function getGlassRingClasses(
  tone: GlassRingToneT,
  intensity: GlassRingIntensityT = "subtle"
): string {
  return GLASS_RING_TONE_CLASSES[tone][intensity];
}

/** Strong primary glow reused by sliders and other accent controls. */
export const PRIMARY_STRONG_GLOW_SHADOW =
  "shadow-[0_0_20px_-3px_rgba(226,121,46,0.7)]";
