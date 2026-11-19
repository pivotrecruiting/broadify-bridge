import { getErrorCode } from "./error-code.js";
import { EngineError, EngineErrorCode } from "../engine/engine-errors.js";
import { GraphicsError } from "../graphics/graphics-errors.js";

describe("getErrorCode", () => {
  it("returns code from EngineError", () => {
    expect(
      getErrorCode(new EngineError(EngineErrorCode.NOT_CONNECTED, "not connected"))
    ).toBe(EngineErrorCode.NOT_CONNECTED);
  });

  it("returns code from GraphicsError", () => {
    expect(
      getErrorCode(new GraphicsError("renderer_error", "renderer failed"))
    ).toBe("renderer_error");
  });

  it("returns code from duck-typed errors", () => {
    expect(getErrorCode({ code: "X" })).toBe("X");
  });

  it("returns undefined for plain Error", () => {
    expect(getErrorCode(new Error("plain"))).toBeUndefined();
  });

  it("returns undefined for non-object values", () => {
    expect(getErrorCode("boom")).toBeUndefined();
    expect(getErrorCode(null)).toBeUndefined();
  });
});
