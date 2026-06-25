import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { GlassRing } from "@/components/ui/glass/glass-ring";
import { GLASS_BUTTON_CLASSES } from "@/components/ui/glass/glass-button-styles";
import type {
  GlassRingIntensityT,
  GlassRingToneT,
} from "@/components/ui/glass/glass-ring-tokens";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center active:scale-95 gap-2 cursor-pointer whitespace-nowrap rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: GLASS_BUTTON_CLASSES,
        cta: GLASS_BUTTON_CLASSES,
        destructive:
          "bg-destructive text-destructive-foreground border-transparent shadow-none backdrop-blur-none hover:bg-destructive/90 hover:text-destructive-foreground focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60 dark:hover:bg-destructive/70",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 min-h-[44px] px-5 py-2 has-[>svg]:px-4",
        sm: "h-8 min-h-[44px] rounded-full gap-1.5 px-4 has-[>svg]:px-3 sm:min-h-0",
        lg: "h-10 min-h-[44px] rounded-full px-6 has-[>svg]:px-4",
        icon: "size-11 min-h-[44px] min-w-[44px]",
        "icon-xs": "size-7 min-h-[28px] min-w-[28px]",
        "icon-sm": "size-9 min-h-[36px] min-w-[36px]",
        "icon-lg": "size-12 min-h-[48px] min-w-[48px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonPropsT = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** When true (or aria-pressed), renders a strong primary ring overlay. */
    active?: boolean;
    /** Ring tone; defaults to primary for default variant and when active on outline. */
    ringTone?: GlassRingToneT | null;
    /** Ring intensity; strong when active or aria-pressed unless overridden. */
    ringIntensity?: GlassRingIntensityT;
  };

function resolveRingTone(
  variant: ButtonPropsT["variant"],
  ringTone: GlassRingToneT | null | undefined,
  active: boolean
): GlassRingToneT | null {
  if (ringTone === null) {
    return null;
  }
  if (ringTone !== undefined) {
    return ringTone;
  }
  if (
    variant === "default" ||
    variant === "cta" ||
    (variant === "outline" && active)
  ) {
    return "primary";
  }
  return null;
}

function resolveRingIntensity(
  ringIntensity: GlassRingIntensityT | undefined,
  variant: ButtonPropsT["variant"],
  active: boolean,
  ariaPressed: boolean | "true" | "false" | "mixed" | undefined
): GlassRingIntensityT {
  if (ringIntensity) {
    return ringIntensity;
  }
  if (variant === "cta") {
    return "strong";
  }
  if (active || ariaPressed === true || ariaPressed === "true") {
    return "strong";
  }
  return "subtle";
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  active = false,
  ringTone,
  ringIntensity,
  children,
  "aria-pressed": ariaPressed,
  ...props
}: ButtonPropsT) {
  const resolvedRingTone = resolveRingTone(variant, ringTone, active);
  const resolvedRingIntensity = resolveRingIntensity(
    ringIntensity,
    variant,
    active,
    ariaPressed
  );
  const showRing = resolvedRingTone !== null;
  const computedClassName = cn(
    buttonVariants({ variant, size, className }),
    showRing && "relative"
  );

  if (asChild) {
    if (showRing && React.isValidElement(children)) {
      return (
        <Slot
          data-slot="button"
          className={computedClassName}
          aria-pressed={ariaPressed}
          {...props}
        >
          {React.cloneElement(
            children,
            undefined,
            <>
              <GlassRing
                tone={resolvedRingTone}
                intensity={resolvedRingIntensity}
              />
              {
                (children as React.ReactElement<{ children?: React.ReactNode }>)
                  .props.children
              }
            </>
          )}
        </Slot>
      );
    }

    return (
      <Slot
        data-slot="button"
        className={computedClassName}
        aria-pressed={ariaPressed}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      data-slot="button"
      className={computedClassName}
      aria-pressed={ariaPressed}
      {...props}
    >
      {showRing && (
        <GlassRing tone={resolvedRingTone} intensity={resolvedRingIntensity} />
      )}
      {children}
    </button>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
