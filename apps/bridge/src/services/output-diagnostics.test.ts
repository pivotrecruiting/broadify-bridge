import {
  buildDisplayDiagnostics,
  buildOutputsDiagnostics,
  getDisplayDeviceCount,
} from "./output-diagnostics.js";

describe("output-diagnostics", () => {
  it("reports ok", () => {
    expect(
      buildOutputsDiagnostics({
        platform: "darwin",
        decklinkRegistered: true,
        decklinkDiagnostics: {
          apiAvailable: true,
          helperMissing: false,
          apiVersion: "12.8",
          helperVersion: "0.1.0",
        },
        decklinkDeviceCount: 1,
      })
    ).toEqual({
      platform: "darwin",
      decklink: {
        state: "ok",
        apiVersion: "12.8",
        helperVersion: "0.1.0",
      },
    });
  });

  it("reports unsupported_platform", () => {
    expect(
      buildOutputsDiagnostics({
        platform: "win32",
        decklinkRegistered: false,
        decklinkDiagnostics: null,
        decklinkDeviceCount: 0,
      }).decklink.state
    ).toBe("unsupported_platform");
  });

  it("reports helper_missing", () => {
    expect(
      buildOutputsDiagnostics({
        platform: "darwin",
        decklinkRegistered: true,
        decklinkDiagnostics: { apiAvailable: false, helperMissing: true },
        decklinkDeviceCount: 0,
      }).decklink.state
    ).toBe("helper_missing");
  });

  it("reports api_unavailable", () => {
    expect(
      buildOutputsDiagnostics({
        platform: "darwin",
        decklinkRegistered: true,
        decklinkDiagnostics: {
          apiAvailable: false,
          helperMissing: false,
          message: "DeckLink iterator could not be created",
        },
        decklinkDeviceCount: 0,
      }).decklink
    ).toMatchObject({
      state: "api_unavailable",
      message: "DeckLink iterator could not be created",
    });
  });

  it("reports no_devices", () => {
    expect(
      buildOutputsDiagnostics({
        platform: "darwin",
        decklinkRegistered: true,
        decklinkDiagnostics: { apiAvailable: true, helperMissing: false },
        decklinkDeviceCount: 0,
      }).decklink.state
    ).toBe("no_devices");
  });

  describe("display", () => {
    it("omits display diagnostics when the display module is not registered", () => {
      const result = buildOutputsDiagnostics({
        platform: "linux",
        decklinkRegistered: false,
        decklinkDeviceCount: 0,
        displayRegistered: false,
        displayDiagnostics: null,
        displayDeviceCount: 0,
      });
      expect(result).toEqual({
        platform: "linux",
        decklink: { state: "unsupported_platform" },
      });
      expect("display" in result).toBe(false);
      expect(
        buildDisplayDiagnostics({
          displayRegistered: false,
          displayDiagnostics: { state: "ok" },
          displayDeviceCount: 1,
        }),
      ).toBeUndefined();
    });

    it("passes missing_runtime with message and exitCode through to the outputs diagnostics", () => {
      expect(
        buildOutputsDiagnostics({
          platform: "win32",
          decklinkRegistered: false,
          decklinkDeviceCount: 0,
          displayRegistered: true,
          displayDiagnostics: {
            state: "missing_runtime",
            message: "Native display helper could not start (STATUS_DLL_NOT_FOUND).",
            exitCode: 3_221_225_781,
          },
          displayDeviceCount: 0,
        }),
      ).toEqual({
        platform: "win32",
        decklink: { state: "unsupported_platform" },
        display: {
          state: "missing_runtime",
          message: "Native display helper could not start (STATUS_DLL_NOT_FOUND).",
          exitCode: 3_221_225_781,
        },
      });
    });

    it("reports helper_failed and helper_missing with their messages", () => {
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: { state: "helper_failed", message: "exited with code 7", exitCode: 7 },
          displayDeviceCount: 0,
        }),
      ).toEqual({ state: "helper_failed", message: "exited with code 7", exitCode: 7 });
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: { state: "helper_missing", message: "spawn ENOENT" },
          displayDeviceCount: 0,
        }),
      ).toEqual({ state: "helper_missing", message: "spawn ENOENT" });
    });

    it("reports ok / no_devices / unsupported_platform without extra fields", () => {
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: { state: "ok" },
          displayDeviceCount: 1,
        }),
      ).toEqual({ state: "ok" });
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: { state: "no_devices" },
          displayDeviceCount: 0,
        }),
      ).toEqual({ state: "no_devices" });
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: { state: "unsupported_platform" },
          displayDeviceCount: 0,
        }),
      ).toEqual({ state: "unsupported_platform" });
    });

    it("derives ok / no_devices from the device count when no detection has run yet", () => {
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: null,
          displayDeviceCount: 2,
        }),
      ).toEqual({ state: "ok" });
      expect(
        buildDisplayDiagnostics({
          displayRegistered: true,
          displayDiagnostics: undefined,
          displayDeviceCount: 0,
        }),
      ).toEqual({ state: "no_devices" });
    });

    it("counts only display devices", () => {
      expect(
        getDisplayDeviceCount([
          { type: "display" },
          { type: "decklink" },
          { type: "display" },
        ] as never),
      ).toBe(2);
    });
  });
});
