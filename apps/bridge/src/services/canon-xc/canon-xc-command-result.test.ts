import type { CanonXCResponseT } from "./canon-xc-service.js";
import {
  CANON_XC_DEFAULT_ERROR_CODE,
  canonResponseToCommandResult,
} from "./canon-xc-command-result.js";

const baseResponse: CanonXCResponseT = {
  ok: false,
  message: "Preset recall failed",
  device: null,
  status: null,
  presets: [],
  result: {},
  rawError: null,
  diagnostic: null,
};

describe("canonResponseToCommandResult", () => {
  it("maps ok:true to success:true and keeps the response as data", () => {
    const response: CanonXCResponseT = {
      ...baseResponse,
      ok: true,
      message: "Preset recalled",
      result: { statusCode: 200 },
    };

    expect(canonResponseToCommandResult(response)).toEqual({
      success: true,
      data: response,
    });
  });

  it("maps ok:false with rawError and diagnostic to a failed result", () => {
    const response: CanonXCResponseT = {
      ...baseResponse,
      rawError: "ETIMEDOUT",
      diagnostic: { code: "timeout", hint: "Check the network cable." },
    };

    const result = canonResponseToCommandResult(response);

    expect(result.success).toBe(false);
    expect(result.error).toBe("ETIMEDOUT");
    expect(result.errorCode).toBe("timeout");
    expect(result.data).toBe(response);
  });

  it("falls back to message and the default error code without rawError/diagnostic", () => {
    const result = canonResponseToCommandResult(baseResponse);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Preset recall failed");
    expect(result.errorCode).toBe(CANON_XC_DEFAULT_ERROR_CODE);
    expect(result.errorCode).toBe("canon_xc_failed");
    expect(result.data).toBe(baseResponse);
  });

  it("treats an empty rawError string as missing and uses the message", () => {
    const result = canonResponseToCommandResult({
      ...baseResponse,
      rawError: "",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Preset recall failed");
  });
});
