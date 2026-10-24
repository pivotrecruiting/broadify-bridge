import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { atomicWriteJson } from "../graphics/file-utils.js";

/**
 * Persisted program source selection (<userDataDir>/pgm/pgm-source.json):
 * the helper re-selects it after a restart and the bridge restores it on boot.
 */
export const PgmSourceFileSchema = z
  .object({
    version: z.literal(1),
    input: z.object({ kind: z.enum(["uvc", "decklink"]), stable_key: z.string().min(1), display_name: z.string() }).nullable(),
    profile: z.enum(["auto", "lan", "remote"]).default("auto"),
  })
  .strict();

export type PgmSourceFileT = z.infer<typeof PgmSourceFileSchema>;

export const EMPTY_PGM_SOURCE: PgmSourceFileT = { version: 1, input: null, profile: "auto" };

export class PgmSourceStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, "pgm", "pgm-source.json");
  }

  load(): PgmSourceFileT {
    if (!existsSync(this.filePath)) {
      return EMPTY_PGM_SOURCE;
    }
    try {
      const parsed = PgmSourceFileSchema.safeParse(JSON.parse(readFileSync(this.filePath, "utf8")));
      return parsed.success ? parsed.data : EMPTY_PGM_SOURCE;
    } catch {
      return EMPTY_PGM_SOURCE;
    }
  }

  async save(value: PgmSourceFileT): Promise<void> {
    await atomicWriteJson(this.filePath, PgmSourceFileSchema.parse(value));
  }
}
