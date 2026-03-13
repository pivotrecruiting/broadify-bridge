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
});
