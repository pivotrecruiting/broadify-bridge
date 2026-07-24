import {
  isForbiddenAddress,
  parseGuardedUrl,
} from "./media-download.js";

describe("media-download SSRF guard", () => {
  it("rejects loopback, private, link-local and multicast IPv4 ranges", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.20",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isForbiddenAddress(address)).toBe(true);
    }
  });

  it("allows public IPv4 addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "104.18.0.1"]) {
      expect(isForbiddenAddress(address)).toBe(false);
    }
  });

  it("rejects loopback, ULA, link-local and mapped IPv6 addresses", () => {
    for (const address of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.0.1",
    ]) {
      expect(isForbiddenAddress(address)).toBe(true);
    }
  });

  it("allows public IPv6 addresses", () => {
    expect(isForbiddenAddress("2606:4700::6810:1")).toBe(false);
  });

  it("rejects malformed addresses", () => {
    expect(isForbiddenAddress("not-an-ip")).toBe(true);
    expect(isForbiddenAddress("999.1.1.1")).toBe(true);
  });

  it("accepts only plain HTTPS URLs on port 443", () => {
    expect(() => parseGuardedUrl("https://example.com/file.png")).not.toThrow();
    expect(() =>
      parseGuardedUrl("https://example.com:443/file.png"),
    ).not.toThrow();
    expect(() => parseGuardedUrl("http://example.com/file.png")).toThrow(
      "Only HTTPS",
    );
    expect(() => parseGuardedUrl("https://example.com:8443/x")).toThrow(
      "port 443",
    );
    expect(() => parseGuardedUrl("https://user:pw@example.com/x")).toThrow(
      "Credentials",
    );
    expect(() => parseGuardedUrl("https://127.0.0.1/x")).toThrow("IP-literal");
    expect(() => parseGuardedUrl("https://[::1]/x")).toThrow("IP-literal");
    expect(() => parseGuardedUrl("ftp://example.com/x")).toThrow("Only HTTPS");
    expect(() => parseGuardedUrl("not a url")).toThrow("Invalid download URL");
  });
});
