/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEngineStatus } from "./use-engine-status.js";

const initialState = { status: "disconnected" as const, macros: [] };
const connectedState = {
  status: "connected" as const,
  macros: [],
  ip: "192.168.1.1",
  port: 8080,
};

describe("useEngineStatus", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      engineGetStatus: jest.fn().mockResolvedValue({ success: true, state: initialState }),
      engineConnect: jest.fn().mockResolvedValue({ success: true, state: connectedState }),
      engineDisconnect: jest.fn().mockResolvedValue({ success: true, state: initialState }),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("fetches status on mount and exposes engineState", async () => {
    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.engineState).toEqual(initialState);
    expect(result.current.error).toBeNull();
    expect(globalThis.window.electron.engineGetStatus).toHaveBeenCalled();
  });

  it("does not call electron when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    }, { timeout: 500 });

    expect(result.current.engineState.status).toBe("disconnected");
  });

  it("connect calls engineConnect and updates state", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: connectedState,
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.connect("192.168.1.1", 8080);
    });

    await waitFor(() => {
      expect(result.current.engineState.status).toBe("connected");
    });

    expect(result.current.engineState.ip).toBe("192.168.1.1");
    expect(result.current.engineState.port).toBe(8080);
    expect(globalThis.window.electron.engineConnect).toHaveBeenCalledWith("192.168.1.1", 8080);
  });

  it("disconnect calls engineDisconnect and updates state", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: connectedState,
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.disconnect();
    });

    await waitFor(() => {
      expect(result.current.engineState.status).toBe("disconnected");
    });

    expect(globalThis.window.electron.engineDisconnect).toHaveBeenCalled();
  });

  it("sets error when engineGetStatus returns success: false", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Bridge unreachable",
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Bridge unreachable");
  });

  it("sets engineState when engineGetStatus returns success: false but state present", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: false,
      error: "Partial",
      state: connectedState,
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Partial");
    expect(result.current.engineState).toEqual(connectedState);
  });

  it("sets error when fetchStatus throws", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockRejectedValueOnce(
      new Error("Network error")
    );

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
  });

  it("connect sets error when result.success is false", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: initialState,
    });
    (globalThis.window.electron.engineConnect as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Connection refused",
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.connect("192.168.1.1", 8080);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Connection refused");
  });

  it("connect updates state when result.success is false but state present", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: initialState,
    });
    (globalThis.window.electron.engineConnect as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Partial",
      state: { status: "connecting" as const, macros: [] },
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.connect("192.168.1.1", 8080);
    });

    await waitFor(() => {
      expect(result.current.engineState.status).toBe("connecting");
    });

    expect(result.current.error).toBe("Partial");
  });

  it("connect sets error when engineConnect throws", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: initialState,
    });
    (globalThis.window.electron.engineConnect as jest.Mock).mockRejectedValueOnce(
      new Error("IPC failed")
    );

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.connect("192.168.1.1", 8080);
    });

    await waitFor(() => {
      expect(result.current.error).toBe("IPC failed");
    });
  });

  it("disconnect sets error when result.success is false", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: connectedState,
    });
    (globalThis.window.electron.engineDisconnect as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Disconnect failed",
    });

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.disconnect();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Disconnect failed");
  });

  it("disconnect sets error when engineDisconnect throws", async () => {
    (globalThis.window.electron.engineGetStatus as jest.Mock).mockResolvedValue({
      success: true,
      state: connectedState,
    });
    (globalThis.window.electron.engineDisconnect as jest.Mock).mockRejectedValueOnce(
      new Error("Bridge unreachable")
    );

    const { result } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.disconnect();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Bridge unreachable");
    });
  });

  it("polls fetchStatus when connected", async () => {
    jest.useFakeTimers();
    (globalThis.window.electron.engineGetStatus as jest.Mock)
      .mockResolvedValueOnce({ success: true, state: initialState })
      .mockResolvedValue({ success: true, state: connectedState });

    const { result, unmount } = renderHook(() => useEngineStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.connect("192.168.1.1", 8080);
    });

    await waitFor(() => {
      expect(result.current.engineState.status).toBe("connected");
    });

    const callCountBefore = (globalThis.window.electron.engineGetStatus as jest.Mock).mock.calls.length;

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const callCountAfter = (globalThis.window.electron.engineGetStatus as jest.Mock).mock.calls.length;

    expect(callCountAfter).toBeGreaterThan(callCountBefore);

    unmount();
    jest.useRealTimers();
  });
});
