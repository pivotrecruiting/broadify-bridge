/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEngineMacros } from "./use-engine-macros.js";

const mockMacros = [
  { id: 1, name: "Macro 1", status: "idle" as const },
  { id: 2, name: "Macro 2", status: "running" as const },
];

describe("useEngineMacros", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      engineGetMacros: jest.fn().mockResolvedValue({ success: true, macros: mockMacros }),
      engineRunMacro: jest.fn().mockResolvedValue({ success: true }),
      engineStopMacro: jest.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("fetches macros on mount and exposes them", async () => {
    const { result } = renderHook(() => useEngineMacros());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.macros).toEqual(mockMacros);
    expect(result.current.error).toBeNull();
    expect(globalThis.window.electron.engineGetMacros).toHaveBeenCalled();
  });

  it("does not call electron when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    }, { timeout: 500 });

    expect(result.current.macros).toEqual([]);
  });

  it("sets error when engineGetMacros returns success: false", async () => {
    (globalThis.window.electron.engineGetMacros as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Engine not connected",
    });

    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Engine not connected");
  });

  it("runMacro calls engineRunMacro and refetches macros", async () => {
    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.runMacro(1);
    });

    expect(globalThis.window.electron.engineRunMacro).toHaveBeenCalledWith(1);
    await waitFor(() => {
      expect(globalThis.window.electron.engineGetMacros).toHaveBeenCalledTimes(2);
    });
  });

  it("stopMacro calls engineStopMacro and refetches macros", async () => {
    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      result.current.stopMacro(2);
    });

    expect(globalThis.window.electron.engineStopMacro).toHaveBeenCalledWith(2);
    await waitFor(() => {
      expect(globalThis.window.electron.engineGetMacros).toHaveBeenCalledTimes(2);
    });
  });

  it("sets error and empty macros when fetchMacros throws", async () => {
    (globalThis.window.electron.engineGetMacros as jest.Mock).mockRejectedValueOnce(
      new Error("Network error")
    );

    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.macros).toEqual([]);
  });

  it("runMacro sets error when result.success is false", async () => {
    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    (globalThis.window.electron.engineRunMacro as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Macro not found",
    });

    await act(async () => {
      result.current.runMacro(99);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Macro not found");
  });

  it("runMacro sets error when engineRunMacro throws", async () => {
    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    (globalThis.window.electron.engineRunMacro as jest.Mock).mockRejectedValueOnce(
      new Error("IPC failed")
    );

    await act(async () => {
      result.current.runMacro(1);
    });

    await waitFor(() => {
      expect(result.current.error).toBe("IPC failed");
    });
  });

  it("stopMacro sets error when result.success is false", async () => {
    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    (globalThis.window.electron.engineStopMacro as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Macro not running",
    });

    await act(async () => {
      result.current.stopMacro(1);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Macro not running");
  });

  it("stopMacro sets error when engineStopMacro throws", async () => {
    const { result } = renderHook(() => useEngineMacros());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    (globalThis.window.electron.engineStopMacro as jest.Mock).mockRejectedValueOnce(
      new Error("Bridge unreachable")
    );

    await act(async () => {
      result.current.stopMacro(1);
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Bridge unreachable");
    });
  });
});
