import { isAllowedExternalUrl } from "./external-url.js";

describe("isAllowedExternalUrl", () => {
  it("accepts https URLs", () => {
    expect(isAllowedExternalUrl("https://app.broadify.de")).toBe(true);
  });

  it("accepts http URLs", () => {
    expect(isAllowedExternalUrl("http://localhost:3000")).toBe(true);
  });

  it("rejects non-http protocols", () => {
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects invalid URL strings", () => {
    expect(isAllowedExternalUrl("not-a-url")).toBe(false);
  });
});
