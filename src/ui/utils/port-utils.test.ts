import {
  validatePort,
  parsePort,
  shouldUseCustomPort,
  calculatePortToUse,
} from "./port-utils.js";
import type { NetworkConfigT } from "@broadify/protocol";

describe("validatePort", () => {
  it("returns true for valid ports", () => {
    expect(validatePort("1")).toBe(true);
    expect(validatePort("8080")).toBe(true);
    expect(validatePort("65535")).toBe(true);
  });

  it("returns false for invalid ports", () => {
    expect(validatePort("")).toBe(false);
    expect(validatePort("   ")).toBe(false);
    expect(validatePort("0")).toBe(false);
    expect(validatePort("65536")).toBe(false);
    expect(validatePort("abc")).toBe(false);
  });
});

describe("parsePort", () => {
  it("returns number for valid ports", () => {
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  it("returns null for invalid ports", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort("   ")).toBeNull();
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("abc")).toBeNull();
  });
});

describe("shouldUseCustomPort", () => {
  it("returns true when customOnly is set", () => {
    expect(
      shouldUseCustomPort({ customOnly: true }, false, "")
    ).toBe(true);
  });

  it("returns true when showAdvanced and customPort is non-empty", () => {
    expect(
      shouldUseCustomPort(undefined, true, "9000")
    ).toBe(true);
  });

  it("returns false when customPort is empty and not customOnly", () => {
    expect(
      shouldUseCustomPort(undefined, true, "")
    ).toBe(false);
  });

  it("returns false when customPort is whitespace only", () => {
    expect(
      shouldUseCustomPort(undefined, true, "   ")
    ).toBe(false);
  });

  it("returns false when showAdvanced is false", () => {
    expect(
      shouldUseCustomPort(undefined, false, "9000")
    ).toBe(false);
  });
});

describe("calculatePortToUse", () => {
  const networkConfig: NetworkConfigT = {
    networkBinding: {
      default: {
        id: "localhost",
        label: "Localhost",
        bindAddress: "127.0.0.1",
        recommended: true,
        advanced: false,
        description: "Loopback binding",
      },
      options: [],
      filters: { excludeInterfaces: [], excludeIpRanges: [], ipv6: false },
    },
    port: { default: 8787, autoFallback: [8788, 8789], allowCustom: true, customAdvancedOnly: false },
    security: { lanMode: { enabled: false, requireAuth: false, readOnlyWithoutAuth: false } },
  };

  it("returns custom port when useCustomPort is true", () => {
    expect(
      calculatePortToUse(
        { customOnly: true },
        false,
        "9000",
        "8787",
        networkConfig
      )
    ).toBe(9000);
  });

  it("returns defaultPort from portConfig when customPort empty", () => {
    expect(
      calculatePortToUse(
        { customOnly: true, defaultPort: 9999 },
        false,
        "",
        "8787",
        networkConfig
      )
    ).toBe(9999);
  });

  it("returns network port when useCustomPort is false", () => {
    expect(
      calculatePortToUse(
        undefined,
        false,
        "",
        "8000",
        networkConfig
      )
    ).toBe(8000);
  });

  it("returns null when network port is empty and not using custom", () => {
    expect(
      calculatePortToUse(
        undefined,
        false,
        "",
        "",
        networkConfig
      )
    ).toBeNull();
  });

  it("returns null when port value is invalid", () => {
    expect(
      calculatePortToUse(
        { customOnly: true },
        false,
        "invalid",
        "8787",
        networkConfig
      )
    ).toBeNull();
  });
});
