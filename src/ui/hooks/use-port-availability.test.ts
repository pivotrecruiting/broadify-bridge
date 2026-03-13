/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePortAvailability } from "./use-port-availability.js";

const mockNetworkConfig = {
  networkBinding: { default: { id: "x", label: "", bindAddress: "", recommended: false, advanced: false, description: "" }, options: [], filters: { excludeInterfaces: [], excludeIpRanges: [], ipv6: false } },
  port: { default: 8787, autoFallback: [8788, 8789], allowCustom: true, customAdvancedOnly: false },
  security: { lanMode: { enabled: false, requireAuth: false, readOnlyWithoutAuth: false } },
};

const mockBindingOptions = [
  { id: "localhost", label: "Localhost", bindAddress: "127.0.0.1", interface: "lo", recommended: true, advanced: false },
];

describe("usePortAvailability", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    jest.useFakeTimers();
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      checkPortsAvailability: jest.fn().mockResolvedValue([{ port: 8787, available: true }, { port: 8788, available: false }]),
      checkPortAvailability: jest.fn().mockResolvedValue({ port: 8787, available: true }),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("returns portAvailability and checkingPorts from effect", async () => {
    const { result } = renderHook(() =>
      usePortAvailability({
        networkBindingId: "localhost",
        networkPort: "8787",
        customPort: "",
        showAdvanced: false,
        bridgeStatus: { running: false, reachable: false },
        networkConfig: mockNetworkConfig,
        networkBindingOptions: mockBindingOptions,
      })
    );

    expect(result.current.portAvailability).toBeDefined();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });

    await waitFor(() => {
      expect(result.current.checkingPorts).toBe(false);
      expect(result.current.portAvailability.size).toBeGreaterThan(0);
    });
  });

  it("does not check ports when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() =>
      usePortAvailability({
        networkBindingId: "localhost",
        networkPort: "8787",
        customPort: "",
        showAdvanced: false,
        bridgeStatus: { running: false, reachable: false },
        networkConfig: mockNetworkConfig,
        networkBindingOptions: mockBindingOptions,
      })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });
    expect(result.current.checkingPorts).toBe(false);
  });

  it("does not check ports when networkConfig is null", async () => {
    const { result } = renderHook(() =>
      usePortAvailability({
        networkBindingId: "localhost",
        networkPort: "8787",
        customPort: "",
        showAdvanced: false,
        bridgeStatus: { running: false, reachable: false },
        networkConfig: null,
        networkBindingOptions: mockBindingOptions,
      })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });
    expect(globalThis.window?.electron?.checkPortsAvailability).not.toHaveBeenCalled();
  });

  it("does not check ports when bridge is running", async () => {
    const { result } = renderHook(() =>
      usePortAvailability({
        networkBindingId: "localhost",
        networkPort: "8787",
        customPort: "",
        showAdvanced: false,
        bridgeStatus: { running: true, reachable: true },
        networkConfig: mockNetworkConfig,
        networkBindingOptions: mockBindingOptions,
      })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });
    expect(globalThis.window.electron.checkPortsAvailability).not.toHaveBeenCalled();
  });

  it("calls checkPortsAvailability and updates portAvailability when bridge not running", async () => {
    const { result } = renderHook(() =>
      usePortAvailability({
        networkBindingId: "localhost",
        networkPort: "8787",
        customPort: "",
        showAdvanced: false,
        bridgeStatus: { running: false, reachable: false },
        networkConfig: mockNetworkConfig,
        networkBindingOptions: mockBindingOptions,
      })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });

    await waitFor(() => {
      expect(result.current.checkingPorts).toBe(false);
      expect(result.current.portAvailability.size).toBeGreaterThan(0);
    });

    expect(result.current.portAvailability.get(8787)).toBe(true);
    expect(result.current.portAvailability.get(8788)).toBe(false);
    expect(globalThis.window.electron.checkPortsAvailability).toHaveBeenCalledWith(
      [8787, 8788, 8789],
      "127.0.0.1"
    );
  });
});
