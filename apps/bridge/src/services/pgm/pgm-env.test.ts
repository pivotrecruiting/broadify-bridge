import { PGM_DEFAULT_MAX_VIEWERS, parsePgmEnv } from "./pgm-env.js";

describe("parsePgmEnv", () => {
  it("is disabled unless BRIDGE_PGM_PREVIEW=1", () => {
    expect(parsePgmEnv({}).enabled).toBe(false);
    expect(parsePgmEnv({ BRIDGE_PGM_PREVIEW: "true" }).enabled).toBe(false);
    expect(parsePgmEnv({ BRIDGE_PGM_PREVIEW: "1" }).enabled).toBe(true);
  });

  it("clamps the viewer cap and falls back to the default", () => {
    expect(parsePgmEnv({}).maxViewers).toBe(PGM_DEFAULT_MAX_VIEWERS);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "0" }).maxViewers).toBe(PGM_DEFAULT_MAX_VIEWERS);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "abc" }).maxViewers).toBe(PGM_DEFAULT_MAX_VIEWERS);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "2" }).maxViewers).toBe(2);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "99" }).maxViewers).toBe(16);
  });
});
