/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBridgeOutputs } from "./use-bridge-outputs.js";

/** Flush microtasks so async effect setState runs inside act(). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mockOutputs = {
  output1: [{ id: "out-1", name: "Output 1", type: "decklink", available: true }],
  output2: [],
};

describe("useBridgeOutputs", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      bridgeGetOutputs: jest.fn().mockResolvedValue(mockOutputs),
    };
  });

  afterEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("returns initial null outputs and loading state, then fetches on mount", async () => {
    const { result } = renderHook(() => useBridgeOutputs());

    expect(result.current.outputs).toBeNull();
    expect(result.current.loading).toBe(true);

    await flushMicrotasks();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.outputs).toEqual(mockOutputs);
    expect(result.current.error).toBeNull();
    expect(globalThis.window.electron.bridgeGetOutputs).toHaveBeenCalled();
  });

  it("sets error when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useBridgeOutputs());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    }, { timeout: 500 });

    expect(result.current.outputs).toBeNull();
    expect(result.current.error).toBe("Electron API not available");
  });

  it("sets error when bridgeGetOutputs rejects", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    (globalThis.window.electron.bridgeGetOutputs as jest.Mock).mockRejectedValueOnce(
      new Error("Network error")
    );

    const { result } = renderHook(() => useBridgeOutputs());

    await flushMicrotasks();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.outputs).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it("refetch calls bridgeGetOutputs again", async () => {
    const { result } = renderHook(() => useBridgeOutputs());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(globalThis.window.electron.bridgeGetOutputs).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(globalThis.window.electron.bridgeGetOutputs).toHaveBeenCalledTimes(2);
    });
  });
});
