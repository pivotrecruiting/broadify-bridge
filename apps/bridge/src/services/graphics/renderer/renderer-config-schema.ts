import { z } from "zod";

const MAX_FRAME_DIMENSION = 8192;

const ClearColorSchema = z
  .object({
    r: z.number().min(0).max(255),
    g: z.number().min(0).max(255),
    b: z.number().min(0).max(255),
    a: z.number().min(0).max(1),
  })
  .strict();

export const RendererConfigureSchema = z
  .object({
    configId: z.string().min(1).optional(),
    width: z.number().int().positive().max(MAX_FRAME_DIMENSION),
    height: z.number().int().positive().max(MAX_FRAME_DIMENSION),
    fps: z.number().positive(),
    pixelFormat: z
      .number()
      .int()
      .positive()
      .refine((value) => value === 1, {
        message: "pixelFormat must be RGBA8 (1)",
      }),
    framebusName: z.string().optional().default(""),
    framebusSlotCount: z.number().int().nonnegative().optional().default(0),
    framebusSize: z.number().int().nonnegative().optional().default(0),
    backgroundMode: z
      .enum(["transparent", "green", "black", "white"])
      .optional()
      .default("transparent"),
    clearColor: ClearColorSchema.optional(),
    /**
     * Force the renderer to drop its FrameBus writer and attach freshly by
     * name, even when name and geometry are unchanged. Required after the
     * bridge force-recreated the bus region (meeting engine start): the old
     * writer keeps a mapping onto the unlinked region and every frame it
     * writes is invisible to readers of the new region.
     */
    framebusReattach: z.boolean().optional().default(false),
  })
  .strict();

export type RendererConfigureMessageT = z.infer<typeof RendererConfigureSchema>;
