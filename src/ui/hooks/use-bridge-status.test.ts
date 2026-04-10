/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBridgeStatus } from "./use-bridge-status.js";

/** Flush microtasks so async effect setState runs inside act(). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useBridgeStatus", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      bridgeGetStatus: jest.fn().mockResolvedValue({ running: true, reachable: true }),
      subscribeBridgeStatus: jest.fn().mockImplementation((_cb: (s: unknown) => void) => () => {}),
    };
  });

  afterEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("returns initial status then updates from bridgeGetStatus", async () => {
    const { result } = renderHook(() => useBridgeStatus());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.running).toBe(true);
      expect(result.current.reachable).toBe(true);
    });

    expect(globalThis.window.electron.bridgeGetStatus).toHaveBeenCalled();
    expect(globalThis.window.electron.subscribeBridgeStatus).toHaveBeenCalled();
  });

  it("keeps default state when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      expect(result.current.running).toBe(false);
      expect(result.current.reachable).toBe(false);
    }, { timeout: 500 });
  });

  it("updates when subscription callback is invoked", async () => {
    let subscriptionCb: ((s: { running: boolean; reachable: boolean }) => void) | null = null;
    (globalThis.window.electron.subscribeBridgeStatus as jest.Mock).mockImplementation(
      (cb: (s: { running: boolean; reachable: boolean }) => void) => {
        subscriptionCb = cb;
        return () => {};
      }
    );

    (globalThis.window.electron.bridgeGetStatus as jest.Mock).mockResolvedValue({
      running: false,
      reachable: false,
    });

    const { result } = renderHook(() => useBridgeStatus());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.running).toBe(false);
      expect(result.current.reachable).toBe(false);
    });

    act(() => {
      subscriptionCb!({ running: true, reachable: true });
    });

    await waitFor(() => {
      expect(result.current.running).toBe(true);
      expect(result.current.reachable).toBe(true);
    });
  });
});
