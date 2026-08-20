import { mapVcamStartError } from "./vcam-error-mapper.js";

describe("mapVcamStartError", () => {
  it("maps REGDB_E_CLASSNOTREG to vcam_not_registered", () => {
    const mapped = mapVcamStartError(
      "MFCreateVirtualCamera failed 0x80040154 (is broadify-vcam.dll registered? regsvr32 requires elevation)"
    );
    expect(mapped.errorCode).toBe("vcam_not_registered");
    expect(mapped.error).toContain("0x80040154");
    expect(mapped.error).toContain("Reinstall");
  });

  it("maps E_ACCESSDENIED to vcam_access_denied with policy guidance", () => {
    const mapped = mapVcamStartError("IMFVirtualCamera::Start failed 0x80070005");
    expect(mapped.errorCode).toBe("vcam_access_denied");
    expect(mapped.error).toContain("Privacy");
    expect(mapped.error).toContain("0x80070005");
  });

  it("maps the Windows 11 requirement", () => {
    const mapped = mapVcamStartError(
      "Virtual camera requires Windows 11 (MFCreateVirtualCamera unavailable)"
    );
    expect(mapped.errorCode).toBe("vcam_windows11_required");
  });

  it("falls back to vcam_start_failed for unknown failures", () => {
    const mapped = mapVcamStartError("IMFVirtualCamera::Start failed 0xdeadbeef");
    expect(mapped.errorCode).toBe("vcam_start_failed");
    expect(mapped.error).toContain("0xdeadbeef");
  });
});
