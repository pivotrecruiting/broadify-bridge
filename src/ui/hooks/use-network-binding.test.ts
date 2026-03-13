/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react";
import { useNetworkBinding } from "./use-network-binding.js";

const defaultNetworkConfig = {
  networkBinding: { default: { id: "localhost", label: "", bindAddress: "", recommended: false, advanced: false, description: "" }, options: [], filters: { excludeInterfaces: [], excludeIpRanges: [], ipv6: false } },
  port: { default: 8787, autoFallback: [8788, 8789], allowCustom: true, customAdvancedOnly: false },
  security: { lanMode: { enabled: false, requireAuth: false, readOnlyWithoutAuth: false } },
};

const optionsLocalhost = [
  { id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", interface: "lo", recommended: true, advanced: false },
];
const optionsWithAll = [
  { id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", interface: "lo", recommended: true, advanced: false },
  { id: "all", label: "All Interfaces", bindAddress: "0.0.0.0", interface: "all", recommended: false, advanced: true, portConfig: { customOnly: true, defaultPort: 8787 } },
];
const optionsWithCustomOnly = [
  { id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", interface: "lo", recommended: true, advanced: false, portConfig: { customOnly: true, defaultPort: 9000 } },
];

describe("useNetworkBinding", () => {
  it("returns handleBindingChange, getCurrentBindAddress, getCurrentPortConfig", () => {
    const setNetworkBindingId = jest.fn();
    const setNetworkPort = jest.fn();
    const setCustomPort = jest.fn();
    const setShowAdvanced = jest.fn();

    const { result } = renderHook(() =>
      useNetworkBinding({
        networkConfig: defaultNetworkConfig,
        networkBindingOptions: optionsLocalhost,
        networkBindingId: "localhost",
        setNetworkBindingId,
        networkPort: "8787",
        setNetworkPort,
        customPort: "",
        setCustomPort,
        showAdvanced: false,
        setShowAdvanced,
      })
    );

    expect(typeof result.current.handleBindingChange).toBe("function");
    expect(typeof result.current.getCurrentBindAddress).toBe("function");
    expect(typeof result.current.getCurrentPortConfig).toBe("function");
  });

  it("getCurrentBindAddress returns bind address for current networkBindingId", () => {
    const setNetworkBindingId = jest.fn();
    const setNetworkPort = jest.fn();
    const setCustomPort = jest.fn();
    const setShowAdvanced = jest.fn();

    const { result } = renderHook(() =>
      useNetworkBinding({
        networkConfig: defaultNetworkConfig,
        networkBindingOptions: optionsLocalhost,
        networkBindingId: "localhost",
        setNetworkBindingId,
        networkPort: "8787",
        setNetworkPort,
        customPort: "",
        setCustomPort,
        showAdvanced: false,
        setShowAdvanced,
      })
    );

    expect(result.current.getCurrentBindAddress()).toBe("127.0.0.1");
  });

  it("handleBindingChange updates binding and port when selecting option with portConfig", () => {
    const setNetworkBindingId = jest.fn();
    const setNetworkPort = jest.fn();
    const setCustomPort = jest.fn();
    const setShowAdvanced = jest.fn();

    const { result } = renderHook(() =>
      useNetworkBinding({
        networkConfig: defaultNetworkConfig,
        networkBindingOptions: optionsLocalhost,
        networkBindingId: "other",
        setNetworkBindingId,
        networkPort: "8787",
        setNetworkPort,
        customPort: "",
        setCustomPort,
        showAdvanced: false,
        setShowAdvanced,
      })
    );

    act(() => {
      result.current.handleBindingChange("localhost");
    });

    expect(setNetworkBindingId).toHaveBeenCalledWith("localhost");
    expect(setNetworkPort).toHaveBeenCalledWith("8787");
    expect(setShowAdvanced).toHaveBeenCalledWith(false);
  });

  it("handleBindingChange sets custom port and showAdvanced when selecting all", () => {
    const setNetworkBindingId = jest.fn();
    const setNetworkPort = jest.fn();
    const setCustomPort = jest.fn();
    const setShowAdvanced = jest.fn();

    const { result } = renderHook(() =>
      useNetworkBinding({
        networkConfig: defaultNetworkConfig,
        networkBindingOptions: optionsWithAll,
        networkBindingId: "localhost",
        setNetworkBindingId,
        networkPort: "8787",
        setNetworkPort,
        customPort: "",
        setCustomPort,
        showAdvanced: false,
        setShowAdvanced,
      })
    );

    act(() => {
      result.current.handleBindingChange("all");
    });

    expect(setNetworkBindingId).toHaveBeenCalledWith("all");
    expect(setCustomPort).toHaveBeenCalledWith("8787");
    expect(setShowAdvanced).toHaveBeenCalledWith(true);
  });

  it("handleBindingChange uses networkConfig.port.default when option has no portConfig", () => {
    const setNetworkBindingId = jest.fn();
    const setNetworkPort = jest.fn();
    const setCustomPort = jest.fn();
    const setShowAdvanced = jest.fn();

    const { result } = renderHook(() =>
      useNetworkBinding({
        networkConfig: defaultNetworkConfig,
        networkBindingOptions: optionsLocalhost,
        networkBindingId: "x",
        setNetworkBindingId,
        networkPort: "8787",
        setNetworkPort,
        customPort: "",
        setCustomPort,
        showAdvanced: false,
        setShowAdvanced,
      })
    );

    act(() => {
      result.current.handleBindingChange("localhost");
    });

    expect(setNetworkPort).toHaveBeenCalledWith("8787");
  });

  it("getCurrentPortConfig returns portConfig for current binding", () => {
    const setNetworkBindingId = jest.fn();
    const setNetworkPort = jest.fn();
    const setCustomPort = jest.fn();
    const setShowAdvanced = jest.fn();

    const { result } = renderHook(() =>
      useNetworkBinding({
        networkConfig: defaultNetworkConfig,
        networkBindingOptions: optionsWithCustomOnly,
        networkBindingId: "localhost",
        setNetworkBindingId,
        networkPort: "8787",
        setNetworkPort,
        customPort: "",
        setCustomPort,
        showAdvanced: false,
        setShowAdvanced,
      })
    );

    expect(result.current.getCurrentPortConfig()).toEqual({ customOnly: true, defaultPort: 9000 });
  });
});
