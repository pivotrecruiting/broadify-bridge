import { isDevelopmentMode } from "./dev-mode.js";

describe("isDevelopmentMode", () => {
  const originalEnv = process.env.DEVELOPMENT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DEVELOPMENT = originalEnv;
    } else {
      delete process.env.DEVELOPMENT;
    }
  });

  it("returns true when DEVELOPMENT=true", () => {
    process.env.DEVELOPMENT = "true";
    expect(isDevelopmentMode()).toBe(true);
  });

  it("returns true when DEVELOPMENT=TRUE (case insensitive)", () => {
    process.env.DEVELOPMENT = "TRUE";
    expect(isDevelopmentMode()).toBe(true);
  });

  it("returns false when DEVELOPMENT is empty", () => {
    process.env.DEVELOPMENT = "";
    expect(isDevelopmentMode()).toBe(false);
  });

  it("returns false when DEVELOPMENT is not set", () => {
    delete process.env.DEVELOPMENT;
    expect(isDevelopmentMode()).toBe(false);
  });

  it("returns false when DEVELOPMENT is not true", () => {
    process.env.DEVELOPMENT = "false";
    expect(isDevelopmentMode()).toBe(false);
  });
});
