/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";

jest.mock("./updater-env.js", () => ({
  getUpdaterEnv: () => ({ DEV: false, VITE_FAKE_UPDATE_AVAILABLE: "" }),
}));

import { useAppUpdater } from "./use-app-updater.js";

/** Flush microtasks so async effect setState runs inside act(). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const initialStatus = {
  enabled: true,
  state: "idle" as const,
  currentVersion: "0.13.0",
  availableVersion: null,
  downloadedVersion: null,
  channel: "latest",
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  lastCheckedAt: null,
  errorCode: null,
  message: "Ready",
};

const availableStatus = {
  ...initialStatus,
  state: "available" as const,
  availableVersion: "0.14.0",
  message: "Update available",
};

describe("useAppUpdater", () => {
  const originalElectron = globalThis.window?.electron;

  beforeEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      updaterGetStatus: jest.fn().mockResolvedValue(initialStatus),
      subscribeUpdaterStatus: jest.fn().mockImplementation((cb: (s: unknown) => void) => {
        return () => {};
      }),
      updaterCheckForUpdates: jest.fn().mockResolvedValue({ success: true, status: availableStatus }),
      updaterDownloadUpdate: jest.fn().mockResolvedValue({
        success: true,
        status: { ...availableStatus, state: "downloaded" as const, downloadedVersion: "0.14.0" },
      }),
      updaterQuitAndInstall: jest.fn().mockResolvedValue({
        success: true,
        status: { ...initialStatus, message: "Installing" },
      }),
    };
  });

  afterEach(() => {
    (globalThis.window as unknown as { electron?: unknown }).electron = originalElectron;
    jest.clearAllMocks();
  });

  it("returns initial status and null actionError, then updates from updaterGetStatus", async () => {
    const { result } = renderHook(() => useAppUpdater());

    expect(result.current.status.state).toBe("disabled");
    expect(result.current.actionError).toBeNull();

    await flushMicrotasks();

    await waitFor(() => {
      expect(result.current.status.currentVersion).toBe("0.13.0");
      expect(result.current.status.state).toBe("idle");
    });

    expect(globalThis.window.electron.updaterGetStatus).toHaveBeenCalled();
    expect(globalThis.window.electron.subscribeUpdaterStatus).toHaveBeenCalled();
  });

  it("sets actionError when updaterGetStatus rejects", async () => {
    (globalThis.window.electron.updaterGetStatus as jest.Mock).mockRejectedValueOnce(
      new Error("Updater not available")
    );

    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();

    await waitFor(() => {
      expect(result.current.actionError).toBe("Updater not available");
    });
  });

  it("checkForUpdates returns fallback and sets actionError when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useAppUpdater());

    await waitFor(() => {
      expect(result.current.status.state).toBe("disabled");
    }, { timeout: 500 });

    let checkResult: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      checkResult = await result.current.checkForUpdates();
    });

    expect(checkResult.success).toBe(false);
    expect(checkResult.error).toBe("Electron API not available");
    expect(result.current.actionError).toBe("Electron API not available");
  });

  it("checkForUpdates calls updaterCheckForUpdates and updates status when electron present", async () => {
    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.status.state).toBe("idle");
    });

    let checkResult: { success: boolean; status: { state: string } } | undefined;
    await act(async () => {
      checkResult = await result.current.checkForUpdates();
    });

    expect(checkResult?.success).toBe(true);
    expect(checkResult?.status.state).toBe("available");
    expect(result.current.status.state).toBe("available");
    expect(result.current.status.availableVersion).toBe("0.14.0");
    expect(globalThis.window.electron.updaterCheckForUpdates).toHaveBeenCalled();
  });

  it("downloadUpdate calls updaterDownloadUpdate and updates status from result", async () => {
    const downloadedStatus = { ...availableStatus, state: "downloaded" as const, downloadedVersion: "0.14.0" };
    (globalThis.window.electron.updaterDownloadUpdate as jest.Mock).mockResolvedValueOnce({
      success: true,
      status: downloadedStatus,
    });

    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.status.state).toBe("idle");
    });

    result.current.checkForUpdates();
    await waitFor(() => {
      expect(result.current.status.state).toBe("available");
    });

    let downloadResult: { success: boolean; status: { state: string } } | undefined;
    await act(async () => {
      downloadResult = await result.current.downloadUpdate();
    });

    expect(downloadResult?.success).toBe(true);
    expect(downloadResult?.status.state).toBe("downloaded");
    expect(result.current.status.state).toBe("downloaded");
    expect(globalThis.window.electron.updaterDownloadUpdate).toHaveBeenCalled();
  });

  it("quitAndInstall calls updaterQuitAndInstall and updates status from result", async () => {
    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.status.state).toBe("idle");
    });

    let installResult: { success: boolean; status: { message: string } } | undefined;
    await act(async () => {
      installResult = await result.current.quitAndInstall();
    });

    expect(installResult?.success).toBe(true);
    expect(installResult?.status.message).toBe("Installing");
    expect(globalThis.window.electron.updaterQuitAndInstall).toHaveBeenCalled();
  });

  it("subscribeUpdaterStatus callback updates status", async () => {
    let subscriptionCb: ((s: typeof initialStatus) => void) | null = null;
    (globalThis.window.electron.subscribeUpdaterStatus as jest.Mock).mockImplementation(
      (cb: (s: typeof initialStatus) => void) => {
        subscriptionCb = cb;
        return () => {};
      }
    );

    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.status.state).toBe("idle");
    });

    const newStatus = { ...initialStatus, state: "checking" as const, message: "Checking..." };
    act(() => {
      subscriptionCb!(newStatus);
    });

    await waitFor(() => {
      expect(result.current.status.state).toBe("checking");
      expect(result.current.status.message).toBe("Checking...");
    });
  });
});
