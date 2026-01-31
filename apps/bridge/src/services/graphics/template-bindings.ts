import type { GraphicsBundleT } from "./graphics-schemas.js";

type TemplateSchemaEntryT = {
  type?: string;
  contentType?: string;
  unit?: string;
};

/**
 * Derived template bindings used by the renderer.
 */
export type TemplateBindingsT = {
  cssVariables: Record<string, string>;
  textContent: Record<string, string>;
  textTypes: Record<string, string>;
  animationClass: string;
};

const VALID_ANIMATION_VALUES = new Set([
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const formatCssValue = (value: unknown, unit?: string): string => {
  if (typeof value === "number") {
    return unit ? `${value}${unit}` : String(value);
  }
  return String(value);
};

const normalizeSchemaEntry = (value: unknown): TemplateSchemaEntryT | null => {
  if (!isRecord(value)) {
    return null;
  }

  const type =
    typeof value.type === "string" ? value.type : undefined;
  const contentType =
    typeof value.contentType === "string" ? value.contentType : undefined;
  const unit =
    typeof value.unit === "string" ? value.unit : undefined;

  if (!type && !contentType && !unit) {
    return null;
  }

  return { type, contentType, unit };
};

/**
 * Resolve the animation class name from a value.
 *
 * @param value Raw animation value from payload/defaults.
 * @returns Normalized animation CSS class.
 */
export function getAnimationClassFromValue(value: unknown): string {
  const normalized = String(value ?? "ease-out").toLowerCase().trim();
  if (VALID_ANIMATION_VALUES.has(normalized)) {
    return `anim-${normalized}`;
  }
  return "anim-ease-out";
}

/**
 * Derive template bindings (CSS variables, text content, animation class).
 *
 * @param bundle Template schema/defaults definition.
 * @param values Runtime values for the template.
 * @returns Precomputed bindings for renderer updates.
 */
export function deriveTemplateBindings(
  bundle: Pick<GraphicsBundleT, "schema" | "defaults">,
  values: Record<string, unknown>
): TemplateBindingsT {
  const cssVariables: Record<string, string> = {};
  const textContent: Record<string, string> = {};
  const textTypes: Record<string, string> = {};

  const schema = isRecord(bundle.schema) ? bundle.schema : {};
  const defaults = isRecord(bundle.defaults) ? bundle.defaults : {};

  Object.keys(schema).forEach((key) => {
    const entry = normalizeSchemaEntry(schema[key]);
    if (!entry || !entry.type) {
      return;
    }

    const value =
      values[key] !== undefined ? values[key] : defaults[key];
    if (value === undefined || value === null) {
      return;
    }

    if (entry.type === "string" && entry.contentType) {
      textContent[key] = String(value);
      textTypes[key] = entry.contentType;
      return;
    }

    if (entry.type === "number") {
      cssVariables[`--${key}`] = formatCssValue(value, entry.unit);
      return;
    }

    cssVariables[`--${key}`] = formatCssValue(value);
  });

  const animationEntry = normalizeSchemaEntry(schema.animation);
  const animationValue =
    animationEntry?.type === "string"
      ? (values.animation !== undefined
        ? values.animation
        : defaults.animation)
      : undefined;

  return {
    cssVariables,
    textContent,
    textTypes,
    animationClass: getAnimationClassFromValue(animationValue),
  };
}
