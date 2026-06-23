import { cn } from "@/lib/utils";
import {
  getGlassRingClasses,
  type GlassRingIntensityT,
  type GlassRingToneT,
} from "@/components/ui/glass/glass-ring-tokens";

export type { GlassRingIntensityT, GlassRingToneT };

type GlassRingPropsT = {
  tone: GlassRingToneT;
  intensity?: GlassRingIntensityT;
  className?: string;
};

/**
 * Decorative ring (colored border + glow) for glass elements.
 *
 * Rendered as an absolutely positioned sibling layer rather than as classes on
 * the element itself: the glass utilities (`glass-bg`, `glass-surface`, …) set
 * their own `border` and `box-shadow`, which win the cascade and would clobber
 * a border/glow applied directly to the element. The parent must be positioned
 * (`relative`) and define the border radius — the ring inherits it.
 */
export function GlassRing({
  tone,
  intensity = "subtle",
  className,
}: GlassRingPropsT) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-10 rounded-[inherit] border-2",
        getGlassRingClasses(tone, intensity),
        className
      )}
    />
  );
}
