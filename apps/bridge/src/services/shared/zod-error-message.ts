import type { z } from "zod";

export function isZodError(error: unknown): error is z.ZodError {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ZodError"
  );
}

export function formatZodError(error: z.ZodError, prefix: string): string {
  const details = error.errors
    .map((issue) => {
      const path = issue.path.join(".") || "payload";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `${prefix}: ${details}`;
}
