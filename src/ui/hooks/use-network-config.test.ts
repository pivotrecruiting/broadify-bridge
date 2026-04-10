/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNetworkConfig } from "./use-network-config.js";

/** Flush microtasks so async effect setState runs inside act(). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mockNetworkConfig = {
  networkBinding: {
    default: { id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", recommended: true, advanced: false, description: "" },
    options: [{ id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", interface: "lo", recommended: true, advanced: false }],
    filters: { excludeInterfaces: [], excludeIpRanges: [], ipv6: false },
  },
  port: { default: 8787, autoFallback: [8788, 8789], allowCustom: true, customAdvancedOnly: false },
  security: { lanMode: { enabled: false, requireAuth: false, readOnlyWithoutAuth: false } },
};

const mockBindingOptions = [
  { id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", interface: "lo", recommended: true, advanced: false },
];

describe("useNetworkConfig", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      getNetworkConfig: jest.fn().mockResolvedValue(mockNetworkConfig),
      getNetworkBindingOptions: jest.fn().mockResolvedValue(mockBindingOptions),
    };
  });

  afterEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("loads config on mount and exposes state", async () => {
    const { result } = renderHook(() => useNetworkConfig());

    expect(result.current.networkConfig).toBeNull();

    await flushMicrotasks();

    await waitFor(() => {
      expect(result.current.networkConfig).toEqual(mockNetworkConfig);
    });

    expect(result.current.networkBindingId).toBe("localhost");
    expect(result.current.networkBindingOptions).toEqual(mockBindingOptions);
    expect(result.current.networkPort).toBe("8787");
    expect(result.current.showAdvanced).toBe(false);
    expect(globalThis.window.electron.getNetworkConfig).toHaveBeenCalled();
    expect(globalThis.window.electron.getNetworkBindingOptions).toHaveBeenCalled();
  });

  it("does not load when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useNetworkConfig());

    await waitFor(() => {
      expect(result.current.networkConfig).toBeNull();
      expect(result.current.networkBindingOptions).toEqual([]);
    }, { timeout: 500 });
  });

  it("exposes setters for binding, port, customPort, showAdvanced", async () => {
    const { result } = renderHook(() => useNetworkConfig());

    await flushMicrotasks();

    expect(typeof result.current.setNetworkBindingId).toBe("function");
    expect(typeof result.current.setNetworkPort).toBe("function");
    expect(typeof result.current.setCustomPort).toBe("function");
    expect(typeof result.current.setShowAdvanced).toBe("function");
  });
});
