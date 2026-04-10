import { useCallback, useEffect, useRef, useState } from "react";
import type { AppUpdaterActionResultT, AppUpdaterStatusT } from "@broadify/protocol";
import { getUpdaterEnv } from "./updater-env.js";

const INITIAL_STATUS: AppUpdaterStatusT = {
  enabled: false,
  state: "disabled",
  currentVersion: "",
  availableVersion: null,
  downloadedVersion: null,
  channel: "latest",
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  lastCheckedAt: null,
  errorCode: null,
  message: "Auto-update status not loaded.",
};
const FAKE_UPDATE_APPEAR_DELAY_MS = 800;
const FAKE_UPDATE_DOWNLOAD_DELAY_MS = 1200;

/**
 * Return true when the renderer should simulate the update flow in development.
 */
function isFakeUpdateEnabled(): boolean {
  const env = getUpdaterEnv();
  return Boolean(env.DEV && env.VITE_FAKE_UPDATE_AVAILABLE === "1");
}

/**
 * Derive a predictable fake update version for development-only UI testing.
 */
function getFakeAvailableVersion(currentVersion: string): string {
  const semverMatch = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!semverMatch) {
    return "0.0.1";
  }

  const major = Number.parseInt(semverMatch[1], 10);
  const minor = Number.parseInt(semverMatch[2], 10);
  const patch = Number.parseInt(semverMatch[3], 10) + 1;
  return `${major}.${minor}.${patch}`;
}

/**
 * Build a simulated "update available" status for development.
 */
function buildFakeAvailableStatus(baseStatus: AppUpdaterStatusT): AppUpdaterStatusT {
  const availableVersion = getFakeAvailableVersion(baseStatus.currentVersion || "0.0.0");

  return {
    ...baseStatus,
    enabled: true,
    state: "available",
    availableVersion,
    downloadedVersion: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    lastCheckedAt: new Date().toISOString(),
    errorCode: null,
    message: `Update ${availableVersion} is available.`,
  };
}

/**
 * Build a simulated "update downloaded" status for development.
 */
function buildFakeDownloadedStatus(baseStatus: AppUpdaterStatusT): AppUpdaterStatusT {
  const downloadedVersion =
    baseStatus.availableVersion || getFakeAvailableVersion(baseStatus.currentVersion || "0.0.0");

  return {
    ...baseStatus,
    enabled: true,
    state: "downloaded",
    availableVersion: downloadedVersion,
    downloadedVersion,
    progressPercent: 100,
    bytesPerSecond: null,
    transferredBytes: baseStatus.totalBytes,
    totalBytes: baseStatus.totalBytes,
    errorCode: null,
    message: `Update ${downloadedVersion} downloaded. Restart to install.`,
  };
}

/**
 * Hook to expose updater state and actions for the UI.
 */
export function useAppUpdater() {
  const [status, setStatus] = useState<AppUpdaterStatusT>(INITIAL_STATUS);
  const [actionError, setActionError] = useState<string | null>(null);
  const fakeUpdateEnabled = isFakeUpdateEnabled();
  const fakeUpdateTimerRef = useRef<number | null>(null);

  const clearFakeUpdateTimer = useCallback(() => {
    if (fakeUpdateTimerRef.current !== null) {
      window.clearTimeout(fakeUpdateTimerRef.current);
      fakeUpdateTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!window.electron) {
      return;
    }

    window.electron
      .updaterGetStatus()
      .then((initialStatus) => {
        setStatus(initialStatus);

        if (fakeUpdateEnabled) {
          clearFakeUpdateTimer();
          fakeUpdateTimerRef.current = window.setTimeout(() => {
            setStatus(buildFakeAvailableStatus(initialStatus));
            setActionError(null);
          }, FAKE_UPDATE_APPEAR_DELAY_MS);
        }
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to load updater status";
        setActionError(message);
      });

    const unsubscribe = fakeUpdateEnabled
      ? () => {}
      : window.electron.subscribeUpdaterStatus((nextStatus) => {
          setStatus(nextStatus);
        });

    return () => {
      clearFakeUpdateTimer();
      unsubscribe();
    };
  }, [clearFakeUpdateTimer, fakeUpdateEnabled]);

  const runUpdaterAction = useCallback(
    async (action: () => Promise<AppUpdaterActionResultT>): Promise<AppUpdaterActionResultT> => {
      const result = await action();
      setStatus(result.status);
      setActionError(result.success ? null : result.error || "Updater action failed");
      return result;
    },
    [],
  );

  const checkForUpdates = useCallback(async () => {
    if (!window.electron) {
      const fallback = {
        success: false,
        status,
        error: "Electron API not available",
      } satisfies AppUpdaterActionResultT;
      setActionError(fallback.error || null);
      return fallback;
    }

    if (fakeUpdateEnabled) {
      clearFakeUpdateTimer();
      const fakeStatus = buildFakeAvailableStatus(status);
      setStatus(fakeStatus);
      setActionError(null);
      return {
        success: true,
        status: fakeStatus,
      } satisfies AppUpdaterActionResultT;
    }

    return runUpdaterAction(() => window.electron.updaterCheckForUpdates());
  }, [clearFakeUpdateTimer, fakeUpdateEnabled, runUpdaterAction, status]);

  const downloadUpdate = useCallback(async () => {
    if (!window.electron) {
      const fallback = {
        success: false,
        status,
        error: "Electron API not available",
      } satisfies AppUpdaterActionResultT;
      setActionError(fallback.error || null);
      return fallback;
    }

    if (fakeUpdateEnabled) {
      if (status.state !== "available") {
        const fallback = {
          success: false,
          status,
          error: "No update available for download.",
        } satisfies AppUpdaterActionResultT;
        setActionError(fallback.error || null);
        return fallback;
      }

      clearFakeUpdateTimer();
      const downloadingStatus: AppUpdaterStatusT = {
        ...status,
        state: "downloading",
        progressPercent: 42,
        bytesPerSecond: 1_500_000,
        transferredBytes: 42,
        totalBytes: 100,
        errorCode: null,
        message: "Downloading update (42.0%).",
      };

      setStatus(downloadingStatus);
      setActionError(null);

      return await new Promise<AppUpdaterActionResultT>((resolve) => {
        fakeUpdateTimerRef.current = window.setTimeout(() => {
          const downloadedStatus = buildFakeDownloadedStatus({
            ...downloadingStatus,
            transferredBytes: 100,
            totalBytes: 100,
          });

          setStatus(downloadedStatus);
          resolve({
            success: true,
            status: downloadedStatus,
          });
        }, FAKE_UPDATE_DOWNLOAD_DELAY_MS);
      });
    }

    return runUpdaterAction(() => window.electron.updaterDownloadUpdate());
  }, [clearFakeUpdateTimer, fakeUpdateEnabled, runUpdaterAction, status]);

  const quitAndInstall = useCallback(async () => {
    if (!window.electron) {
      const fallback = {
        success: false,
        status,
        error: "Electron API not available",
      } satisfies AppUpdaterActionResultT;
      setActionError(fallback.error || null);
      return fallback;
    }

    if (fakeUpdateEnabled) {
      if (status.state !== "downloaded") {
        const fallback = {
          success: false,
          status,
          error: "No downloaded update is ready to install.",
        } satisfies AppUpdaterActionResultT;
        setActionError(fallback.error || null);
        return fallback;
      }

      const finalStatus: AppUpdaterStatusT = {
        ...status,
        errorCode: null,
        message: "Development mode: simulated install would restart the app now.",
      };

      setStatus(finalStatus);
      setActionError(null);
      return {
        success: true,
        status: finalStatus,
      } satisfies AppUpdaterActionResultT;
    }

    return runUpdaterAction(() => window.electron.updaterQuitAndInstall());
  }, [fakeUpdateEnabled, runUpdaterAction, status]);

  return {
    status,
    actionError,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
  };
}
