import { PGM_DEFAULT_MAX_VIEWERS, PGM_WINDOWS_ENV, isPgmPlatformSupported, parsePgmEnv, pgmUnsupportedPlatformMessage } from "./pgm-env.js";

describe("parsePgmEnv", () => {
  it("is on by default and off only with BRIDGE_PGM_PREVIEW=0", () => {
    expect(parsePgmEnv({}).enabled).toBe(true);
    expect(parsePgmEnv({ BRIDGE_PGM_PREVIEW: "1" }).enabled).toBe(true);
    expect(parsePgmEnv({ BRIDGE_PGM_PREVIEW: "0" }).enabled).toBe(false);
    expect(parsePgmEnv({ BRIDGE_PGM_PREVIEW: "off" }).enabled).toBe(false);
  });

  it("clamps the viewer cap and falls back to the default", () => {
    expect(parsePgmEnv({}).maxViewers).toBe(PGM_DEFAULT_MAX_VIEWERS);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "0" }).maxViewers).toBe(PGM_DEFAULT_MAX_VIEWERS);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "abc" }).maxViewers).toBe(PGM_DEFAULT_MAX_VIEWERS);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "2" }).maxViewers).toBe(2);
    expect(parsePgmEnv({ BRIDGE_PGM_MAX_VIEWERS: "99" }).maxViewers).toBe(16);
  });
});

describe("isPgmPlatformSupported", () => {
  it("is always on for macOS, whatever the Windows switch says", () => {
    expect(isPgmPlatformSupported("darwin", {})).toBe(true);
    expect(isPgmPlatformSupported("darwin", { BRIDGE_PGM_WINDOWS: "0" })).toBe(true);
  });

  it("is off on Windows unless BRIDGE_PGM_WINDOWS is 1, true or on", () => {
    expect(PGM_WINDOWS_ENV).toBe("BRIDGE_PGM_WINDOWS");
    expect(isPgmPlatformSupported("win32", {})).toBe(false);
    for (const value of ["", "0", "false", "off", "no", "yes", "2", "enabled"]) {
      expect(isPgmPlatformSupported("win32", { BRIDGE_PGM_WINDOWS: value })).toBe(false);
    }
    for (const value of ["1", "true", "on", "TRUE", " On ", "1\n"]) {
      expect(isPgmPlatformSupported("win32", { BRIDGE_PGM_WINDOWS: value })).toBe(true);
    }
  });

  it("stays off on other platforms, also with the switch", () => {
    expect(isPgmPlatformSupported("linux", { BRIDGE_PGM_WINDOWS: "1" })).toBe(false);
  });

  it("does not touch the kill switch", () => {
    expect(parsePgmEnv({ BRIDGE_PGM_WINDOWS: "1" }).enabled).toBe(true);
    expect(isPgmPlatformSupported("win32", { BRIDGE_PGM_WINDOWS: "1", BRIDGE_PGM_PREVIEW: "0" })).toBe(true);
  });

  it("tells Windows apart from other unsupported platforms in the refusal message", () => {
    expect(pgmUnsupportedPlatformMessage("win32")).toBe("Windows preview not enabled on this bridge.");
    expect(pgmUnsupportedPlatformMessage("linux")).toBe("Live program preview ships for macOS bridges first; Windows follows.");
  });
});
