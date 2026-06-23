import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "../theme/theme-provider";

type ThemeTogglePropsT = {
  className?: string;
};

/** Cycle order for the toggle: dark → light → system → dark. */
const NEXT_THEME: Record<Theme, Theme> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const LABELS: Record<Theme, string> = {
  dark: "Dark mode (click for light)",
  light: "Light mode (click for system)",
  system: "System theme (click for dark)",
};

/**
 * Cycles appearance between dark, light and system. The provider applies the
 * resolved theme to the document root; "system" follows the OS preference.
 * Styled to match the sibling header icon buttons.
 */
export function ThemeToggle({ className }: ThemeTogglePropsT) {
  const { theme, setTheme } = useTheme();

  return (
    <button
      type="button"
      className={`text-card-foreground hover:text-card-foreground/80 transition-colors ${className ?? ""}`}
      aria-label={LABELS[theme]}
      title={LABELS[theme]}
      data-testid="theme-toggle"
      onClick={() => setTheme(NEXT_THEME[theme])}
    >
      {theme === "system" ? (
        <Monitor className="w-5 h-5 sm:w-6 sm:h-6" aria-hidden />
      ) : theme === "dark" ? (
        <Moon className="w-5 h-5 sm:w-6 sm:h-6" aria-hidden />
      ) : (
        <Sun className="w-5 h-5 sm:w-6 sm:h-6" aria-hidden />
      )}
    </button>
  );
}
