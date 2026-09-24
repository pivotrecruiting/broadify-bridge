import { buildOutputsDiagnostics } from "./output-diagnostics.js";

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
});
