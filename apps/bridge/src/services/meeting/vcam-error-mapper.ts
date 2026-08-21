/**
 * Maps raw Windows virtual-camera failures (COM HRESULTs embedded in the
 * helper's error strings) onto stable error codes plus actionable messages.
 * The webapp localizes by errorCode; the raw code stays in the message tail
 * so support can always see the original HRESULT.
 */
export type VcamErrorMappingT = {
  errorCode: string;
  error: string;
};

const HRESULT_PATTERN = /0x([0-9a-fA-F]{8})/;

export function mapVcamStartError(rawMessage: string): VcamErrorMappingT {
  const hex = rawMessage.match(HRESULT_PATTERN)?.[1]?.toLowerCase() ?? null;

  if (hex === "80040154") {
    // REGDB_E_CLASSNOTREG — DLL registration missing and the elevated
    // regsvr32 self-heal did not succeed (declined UAC, blocked policy).
    return {
      errorCode: "vcam_not_registered",
      error: `The virtual camera component is not registered on this system. Reinstall Broadify Bridge or approve the administrator prompt during setup. (${rawMessage})`,
    };
  }

  if (hex === "80070005") {
    // E_ACCESSDENIED — camera privacy toggles or a managed-device policy
    // (device installation restrictions) block creating the camera device.
    return {
      errorCode: "vcam_access_denied",
      error: `Windows denied creating the virtual camera. Check Settings > Privacy & Security > Camera ("Let desktop apps access your camera") — on company-managed devices, IT must allow software camera devices. (${rawMessage})`,
    };
  }

  if (rawMessage.toLowerCase().includes("windows 11")) {
    return {
      errorCode: "vcam_windows11_required",
      error: rawMessage,
    };
  }

  return {
    errorCode: "vcam_start_failed",
    error: rawMessage,
  };
}
