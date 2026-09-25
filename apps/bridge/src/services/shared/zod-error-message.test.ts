import { z } from "zod";

import { formatZodError, isZodError } from "./zod-error-message.js";

describe("zod-error-message", () => {
  it("formats a single issue", () => {
    const result = z
      .object({
        format: z.object({
          displayModeId: z.number().int(),
        }),
      })
      .safeParse({ format: { displayModeId: 13.5 } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error, "Invalid output configuration")).toBe(
        "Invalid output configuration: format.displayModeId: Expected integer, received float",
      );
    }
  });

  it("joins several issues", () => {
    const result = z
      .object({
        outputKey: z.string().min(1),
        format: z.object({
          width: z.number().positive(),
        }),
      })
      .safeParse({ outputKey: "", format: { width: 0 } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error, "Invalid output configuration")).toBe(
        "Invalid output configuration: outputKey: String must contain at least 1 character(s); format.width: Number must be greater than 0",
      );
    }
  });

  it('uses "payload" for an empty path', () => {
    const result = z.string().safeParse(1);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error, "Invalid output configuration")).toBe(
        "Invalid output configuration: payload: Expected string, received number",
      );
    }
  });

  it("accepts a real ZodError and rejects a plain Error", () => {
    const result = z.string().safeParse(1);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isZodError(result.error)).toBe(true);
    }
    expect(isZodError(new Error("plain"))).toBe(false);
  });
});
