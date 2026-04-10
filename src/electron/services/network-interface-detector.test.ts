import os from "os";
import {
  detectNetworkInterfaces,
  resolveBindAddress,
} from "./network-interface-detector.js";

jest.mock("os", () => ({
  __esModule: true,
  default: {
    networkInterfaces: jest.fn(),
  },
}));

describe("network-interface-detector", () => {
  const networkInterfacesMock = os.networkInterfaces as jest.Mock;

  afterEach(() => {
    networkInterfacesMock.mockReset();
  });

  it("resolves AUTO_IPV4 bindings while skipping excluded link-local addresses", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "169.254.20.5",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.0.0",
          cidr: "169.254.20.5/16",
        },
        {
          address: "192.168.10.20",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.10.20/24",
        },
      ],
      "Wi-Fi": [
        {
          address: "10.0.0.25",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "10.0.0.25/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "ethernet-auto",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
        {
          id: "wifi-auto",
          label: "Wi-Fi",
          bindAddress: "AUTO_IPV4",
          interface: "wifi",
          recommended: false,
          advanced: false,
        },
        {
          id: "loopback",
          label: "Loopback",
          bindAddress: "127.0.0.1",
          interface: "loopback",
          recommended: false,
          advanced: true,
        },
      ],
      {
        excludeInterfaces: [],
        excludeIpRanges: ["169.254.0.0/16"],
        ipv6: false,
      }
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "ethernet-auto",
        bindAddress: "192.168.10.20",
      }),
      expect.objectContaining({
        id: "wifi-auto",
        bindAddress: "10.0.0.25",
      }),
      expect.objectContaining({
        id: "loopback",
        bindAddress: "127.0.0.1",
      }),
    ]);
  });

  it("filters excluded interfaces when resolving AUTO_IPV4 bindings", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "192.168.0.20",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.0.20/24",
        },
      ],
      wifi0: [
        {
          address: "10.0.0.50",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "10.0.0.50/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "ethernet-auto",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      {
        excludeInterfaces: ["en0"],
        excludeIpRanges: [],
        ipv6: false,
      }
    );

    expect(result).toEqual([]);
  });

  it("resolves 0.0.0.0 to the first external IPv4 address and falls back to localhost", () => {
    networkInterfacesMock.mockReturnValueOnce({
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.1.77",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.1.77/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("0.0.0.0", "all")).toBe("192.168.1.77");

    networkInterfacesMock.mockReturnValueOnce({
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.1/8",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("AUTO_IPV4", "wifi")).toBe("127.0.0.1");
  });

  it("returns specific bind address as-is without calling networkInterfaces", () => {
    const result = resolveBindAddress("192.168.1.100", "ethernet");
    expect(result).toBe("192.168.1.100");
    expect(networkInterfacesMock).not.toHaveBeenCalled();
  });

  it("resolveBindAddress returns 127.0.0.1 for interfaceType loopback", () => {
    expect(resolveBindAddress("0.0.0.0", "loopback")).toBe("127.0.0.1");
    expect(resolveBindAddress("AUTO_IPV4", "loopback")).toBe("127.0.0.1");
  });

  it("resolveBindAddress 0.0.0.0/all falls back to 127.0.0.1 when no external IP", () => {
    networkInterfacesMock.mockReturnValue({
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.1/8",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("0.0.0.0", "all")).toBe("127.0.0.1");
  });

  it("resolveBindAddress AUTO_IPV4 ethernet returns first matching interface IP", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        {
          address: "10.0.0.5",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "10.0.0.5/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("AUTO_IPV4", "ethernet")).toBe("10.0.0.5");
  });

  it("resolveBindAddress AUTO_IPV4 wifi returns first matching interface IP", () => {
    networkInterfacesMock.mockReturnValue({
      wlan0: [
        {
          address: "192.168.2.10",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.2.10/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("AUTO_IPV4", "wifi")).toBe("192.168.2.10");
  });

  it("resolveBindAddress skips excluded interfaces when resolving 0.0.0.0", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "192.168.0.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.0.1/24",
        },
      ],
      eth1: [
        {
          address: "10.0.0.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "10.0.0.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = resolveBindAddress("0.0.0.0", "all", {
      excludeInterfaces: ["en0"],
      excludeIpRanges: [],
      ipv6: false,
    });
    expect(result).toBe("10.0.0.1");
  });

  it("resolveBindAddress skips addresses in excludeIpRanges (link-local)", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "169.254.10.20",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.0.0",
          cidr: "169.254.10.20/16",
        },
        {
          address: "192.168.1.50",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.1.50/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = resolveBindAddress("0.0.0.0", "all", {
      excludeInterfaces: [],
      excludeIpRanges: ["169.254.0.0/16"],
      ipv6: false,
    });
    expect(result).toBe("192.168.1.50");
  });

  it("resolveBindAddress uses filters when provided", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        {
          address: "192.168.3.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.3.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(
      resolveBindAddress("AUTO_IPV4", "ethernet", {
        excludeInterfaces: [],
        excludeIpRanges: [],
        ipv6: false,
      })
    ).toBe("192.168.3.1");
  });

  it("detectNetworkInterfaces resolves AUTO_IPV4 loopback to 127.0.0.1", () => {
    networkInterfacesMock.mockReturnValue({} as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "loopback-auto",
          label: "Loopback",
          bindAddress: "AUTO_IPV4",
          interface: "loopback",
          recommended: false,
          advanced: true,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "loopback-auto",
        bindAddress: "127.0.0.1",
      }),
    ]);
  });

  it("detectNetworkInterfaces resolves AUTO_IPV4 interface all to 0.0.0.0", () => {
    networkInterfacesMock.mockReturnValue({} as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "all-auto",
          label: "All",
          bindAddress: "AUTO_IPV4",
          interface: "all",
          recommended: false,
          advanced: true,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "all-auto",
        bindAddress: "0.0.0.0",
      }),
    ]);
  });

  it("detectNetworkInterfaces skips AUTO_IPV4 option when no IP detected and keeps others", () => {
    networkInterfacesMock.mockReturnValue({
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.1/8",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "ethernet-auto",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
        {
          id: "fixed",
          label: "Fixed",
          bindAddress: "192.168.99.1",
          interface: "ethernet",
          recommended: false,
          advanced: false,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "fixed",
        bindAddress: "192.168.99.1",
      }),
    ]);
  });

  it("detectNetworkInterfaces passes warning and portConfig through", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "192.168.0.10",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.0.10/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "opt",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: false,
          advanced: false,
          warning: "Custom binding",
          portConfig: { customOnly: true, defaultPort: 8080 },
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result[0].warning).toBe("Custom binding");
    expect(result[0].portConfig).toEqual({ customOnly: true, defaultPort: 8080 });
  });

  it("detectNetworkInterfaces skips IPv6 when ipv6 filter is false", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "fe80::1",
          family: "IPv6",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "ffff::",
          cidr: "fe80::1/64",
        },
        {
          address: "192.168.5.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.5.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "eth",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result[0].bindAddress).toBe("192.168.5.1");
  });

  it("detectNetworkInterfaces skips internal addresses", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "127.0.0.2",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.2/8",
        },
        {
          address: "192.168.6.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.6.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "eth",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result[0].bindAddress).toBe("192.168.6.1");
  });

  it("isIpInRange: link-local range with IP that has fewer than 4 parts returns false", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "169.254.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.0.0",
          cidr: "169.254.1/16",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "eth",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      {
        excludeInterfaces: [],
        excludeIpRanges: ["169.254.0.0/16"],
        ipv6: false,
      }
    );

    expect(result[0].bindAddress).toBe("169.254.1");
  });

  it("isIpInRange: non-link-local range returns false (excludeIpRanges other than 169.254)", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "192.168.7.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.7.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "eth",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      {
        excludeInterfaces: [],
        excludeIpRanges: ["10.0.0.0/8"],
        ipv6: false,
      }
    );

    expect(result[0].bindAddress).toBe("192.168.7.1");
  });

  it("handles interface with null address entry in list", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        null,
        {
          address: "192.168.8.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "192.168.8.1/24",
        },
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "eth",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: false }
    );

    expect(result[0].bindAddress).toBe("192.168.8.1");
  });

  it("resolveBindAddress AUTO_IPV4 skips excluded interfaces", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        {
          address: "10.0.0.2",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          cidr: "10.0.0.2/24",
        },
      ],
      en1: [
        {
          address: "192.168.9.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.9.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = resolveBindAddress("AUTO_IPV4", "ethernet", {
      excludeInterfaces: ["eth0"],
      excludeIpRanges: [],
      ipv6: false,
    });
    expect(result).toBe("192.168.9.1");
  });

  it("detectNetworkInterfaces skips IPv6 address when ipv6 true but still uses IPv4", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "fe80::1",
          family: "IPv6",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "ffff::",
          cidr: "fe80::1/64",
        },
        {
          address: "192.168.10.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.10.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    const result = detectNetworkInterfaces(
      [
        {
          id: "eth",
          label: "Ethernet",
          bindAddress: "AUTO_IPV4",
          interface: "ethernet",
          recommended: true,
          advanced: false,
        },
      ],
      { excludeInterfaces: [], excludeIpRanges: [], ipv6: true }
    );
    expect(result[0].bindAddress).toBe("192.168.10.1");
  });

  it("resolveBindAddress 0.0.0.0 skips IPv6 then returns IPv4 when ipv6 true", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "fe80::2",
          family: "IPv6",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "ffff::",
          cidr: "fe80::2/64",
        },
        {
          address: "192.168.11.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.11.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(
      resolveBindAddress("0.0.0.0", "all", {
        excludeInterfaces: [],
        excludeIpRanges: [],
        ipv6: true,
      })
    ).toBe("192.168.11.1");
  });

  it("resolveBindAddress 0.0.0.0 skips internal address then returns external", () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        {
          address: "127.0.0.2",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.2/8",
        },
        {
          address: "192.168.12.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.12.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("0.0.0.0", "all")).toBe("192.168.12.1");
  });

  it("resolveBindAddress AUTO_IPV4 skips internal address then returns external", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        {
          address: "127.0.0.3",
          family: "IPv4",
          internal: true,
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          cidr: "127.0.0.3/8",
        },
        {
          address: "10.0.0.99",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "10.0.0.99/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("AUTO_IPV4", "ethernet")).toBe("10.0.0.99");
  });

  it("resolveBindAddress AUTO_IPV4 skips address in excludeIpRanges then returns next", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        {
          address: "169.254.1.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.0.0",
          cidr: "169.254.1.1/16",
        },
        {
          address: "192.168.13.1",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
          cidr: "192.168.13.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(
      resolveBindAddress("AUTO_IPV4", "ethernet", {
        excludeInterfaces: [],
        excludeIpRanges: ["169.254.0.0/16"],
        ipv6: false,
      })
    ).toBe("192.168.13.1");
  });

  it("resolveBindAddress 0.0.0.0 when interfaces returns undefined uses fallback", () => {
    networkInterfacesMock.mockReturnValue(undefined as unknown as ReturnType<typeof os.networkInterfaces>);

    expect(resolveBindAddress("0.0.0.0", "all")).toBe("127.0.0.1");
  });
});
