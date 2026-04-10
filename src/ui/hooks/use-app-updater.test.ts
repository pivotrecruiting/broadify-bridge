/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AppUpdaterActionResultT, AppUpdaterStatusT } from "@broadify/protocol";

const mockGetUpdaterEnv = jest.fn(() => ({ DEV: false, VITE_FAKE_UPDATE_AVAILABLE: "" }));
jest.mock("./updater-env.js", () => ({
  getUpdaterEnv: () => mockGetUpdaterEnv(),
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
    mockGetUpdaterEnv.mockReturnValue({ DEV: false, VITE_FAKE_UPDATE_AVAILABLE: "" });
    (globalThis.window as unknown as { electron?: unknown }).electron = {
      updaterGetStatus: jest.fn().mockResolvedValue(initialStatus),
      subscribeUpdaterStatus: jest.fn().mockImplementation((_cb: (s: unknown) => void) => {
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

  it("sets actionError to generic message when updaterGetStatus rejects with non-Error", async () => {
    (globalThis.window.electron.updaterGetStatus as jest.Mock).mockRejectedValueOnce("string error");

    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();

    await waitFor(() => {
      expect(result.current.actionError).toBe("Failed to load updater status");
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

    let installResult: AppUpdaterActionResultT | undefined;
    await act(async () => {
      installResult = await result.current.quitAndInstall();
    });

    expect(installResult?.success).toBe(true);
    expect(installResult?.status.message).toBe("Installing");
    expect(globalThis.window.electron.updaterQuitAndInstall).toHaveBeenCalled();
  });

  it("subscribeUpdaterStatus callback updates status", async () => {
    let subscriptionCb: ((s: AppUpdaterStatusT) => void) | null = null;
    (globalThis.window.electron.subscribeUpdaterStatus as jest.Mock).mockImplementation(
      (cb: (s: AppUpdaterStatusT) => void) => {
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

  it("downloadUpdate returns fallback and sets actionError when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useAppUpdater());

    await waitFor(() => {
      expect(result.current.status.state).toBe("disabled");
    }, { timeout: 500 });

    let downloadResult: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      downloadResult = await result.current.downloadUpdate();
    });

    expect(downloadResult.success).toBe(false);
    expect(downloadResult.error).toBe("Electron API not available");
    expect(result.current.actionError).toBe("Electron API not available");
  });

  it("quitAndInstall returns fallback and sets actionError when window.electron is missing", async () => {
    (globalThis.window as unknown as { electron?: unknown }).electron = undefined;

    const { result } = renderHook(() => useAppUpdater());

    await waitFor(() => {
      expect(result.current.status.state).toBe("disabled");
    }, { timeout: 500 });

    let installResult: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      installResult = await result.current.quitAndInstall();
    });

    expect(installResult.success).toBe(false);
    expect(installResult.error).toBe("Electron API not available");
    expect(result.current.actionError).toBe("Electron API not available");
  });

  it("runUpdaterAction sets actionError when action returns success: false with error", async () => {
    (globalThis.window.electron.updaterCheckForUpdates as jest.Mock).mockResolvedValueOnce({
      success: false,
      status: initialStatus,
      error: "Network error",
    });

    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.status.state).toBe("idle");
    });

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.actionError).toBe("Network error");
  });

  it("runUpdaterAction sets actionError to fallback when action returns success: false without error", async () => {
    (globalThis.window.electron.updaterCheckForUpdates as jest.Mock).mockResolvedValueOnce({
      success: false,
      status: initialStatus,
    });

    const { result } = renderHook(() => useAppUpdater());

    await flushMicrotasks();
    await waitFor(() => {
      expect(result.current.status.state).toBe("idle");
    });

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.actionError).toBe("Updater action failed");
  });

  describe("with fake update enabled", () => {
    beforeEach(() => {
      mockGetUpdaterEnv.mockReturnValue({ DEV: true, VITE_FAKE_UPDATE_AVAILABLE: "1" });
    });

    it("after effect, fake update appears and status becomes available with derived version", async () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.state).toBe("idle");
      });

      act(() => {
        jest.advanceTimersByTime(800);
      });

      await waitFor(() => {
        expect(result.current.status.state).toBe("available");
        expect(result.current.status.availableVersion).toBe("0.13.1");
        expect(result.current.status.message).toContain("0.13.1");
      });

      jest.useRealTimers();
    });

    it("checkForUpdates with fake update sets available immediately without IPC", async () => {
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.state).toBe("idle");
      });

      let checkResult: { success: boolean; status: { state: string; availableVersion: string | null } } | undefined;
      await act(async () => {
        checkResult = await result.current.checkForUpdates();
      });

      expect(checkResult?.success).toBe(true);
      expect(checkResult?.status.state).toBe("available");
      expect(result.current.status.availableVersion).toBe("0.13.1");
      expect(globalThis.window.electron.updaterCheckForUpdates).not.toHaveBeenCalled();
    });

    it("getFakeAvailableVersion returns 0.0.1 for non-semver currentVersion", async () => {
      (globalThis.window.electron.updaterGetStatus as jest.Mock).mockResolvedValueOnce({
        ...initialStatus,
        currentVersion: "dev-build",
      });

      jest.useFakeTimers();
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.currentVersion).toBe("dev-build");
      });

      act(() => {
        jest.advanceTimersByTime(800);
      });

      await waitFor(() => {
        expect(result.current.status.state).toBe("available");
        expect(result.current.status.availableVersion).toBe("0.0.1");
      });

      jest.useRealTimers();
    });

    it("downloadUpdate with fake update and state !== available returns error", async () => {
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.state).toBe("idle");
      });

      let downloadResult: { success: boolean; error?: string } = { success: true };
      await act(async () => {
        downloadResult = await result.current.downloadUpdate();
      });

      expect(downloadResult.success).toBe(false);
      expect(downloadResult.error).toBe("No update available for download.");
      expect(result.current.actionError).toBe("No update available for download.");
      expect(globalThis.window.electron.updaterDownloadUpdate).not.toHaveBeenCalled();
    });

    it("downloadUpdate with fake update and state available runs fake download then downloaded", async () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.state).toBe("idle");
      });

      await act(async () => {
        await result.current.checkForUpdates();
      });
      await waitFor(() => {
        expect(result.current.status.state).toBe("available");
      });

      let downloadPromise: Promise<unknown> | null = null;
      act(() => {
        downloadPromise = result.current.downloadUpdate();
      });

      await waitFor(() => {
        expect(result.current.status.state).toBe("downloading");
        expect(result.current.status.progressPercent).toBe(42);
      });

      act(() => {
        jest.advanceTimersByTime(1200);
      });

      let downloadResult: { success: boolean; status: { state: string } } | undefined;
      await act(async () => {
        downloadResult = await downloadPromise as { success: boolean; status: { state: string } };
      });

      expect(downloadResult?.success).toBe(true);
      expect(downloadResult?.status.state).toBe("downloaded");
      expect(result.current.status.state).toBe("downloaded");
      expect(result.current.status.message).toContain("Restart to install");
      expect(globalThis.window.electron.updaterDownloadUpdate).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it("quitAndInstall with fake update and state !== downloaded returns error", async () => {
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.state).toBe("idle");
      });

      let installResult: { success: boolean; error?: string } = { success: true };
      await act(async () => {
        installResult = await result.current.quitAndInstall();
      });

      expect(installResult.success).toBe(false);
      expect(installResult.error).toBe("No downloaded update is ready to install.");
      expect(result.current.actionError).toBe("No downloaded update is ready to install.");
      expect(globalThis.window.electron.updaterQuitAndInstall).not.toHaveBeenCalled();
    });

    it("quitAndInstall with fake update and state downloaded sets final status", async () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useAppUpdater());

      await flushMicrotasks();
      await waitFor(() => {
        expect(result.current.status.state).toBe("idle");
      });

      await act(async () => {
        await result.current.checkForUpdates();
      });
      await waitFor(() => {
        expect(result.current.status.state).toBe("available");
      });

      act(() => {
        result.current.downloadUpdate();
      });
      act(() => {
        jest.advanceTimersByTime(1200);
      });

      await waitFor(() => {
        expect(result.current.status.state).toBe("downloaded");
      });

      let installResult: AppUpdaterActionResultT | undefined;
      await act(async () => {
        installResult = await result.current.quitAndInstall();
      });

      expect(installResult?.success).toBe(true);
      expect(installResult?.status.message).toContain("simulated install");
      expect(result.current.status.message).toContain("simulated install");
      expect(globalThis.window.electron.updaterQuitAndInstall).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });
});
