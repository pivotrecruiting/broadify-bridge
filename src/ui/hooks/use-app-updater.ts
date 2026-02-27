import { useCallback, useEffect, useState } from "react";
import type { AppUpdaterActionResultT, AppUpdaterStatusT } from "@broadify/protocol";

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

/**
 * Hook to expose updater state and actions for the UI.
 */
export function useAppUpdater() {
  const [status, setStatus] = useState<AppUpdaterStatusT>(INITIAL_STATUS);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.electron) {
      return;
    }

    window.electron
      .updaterGetStatus()
      .then((initialStatus) => {
        setStatus(initialStatus);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to load updater status";
        setActionError(message);
      });

    const unsubscribe = window.electron.subscribeUpdaterStatus((nextStatus) => {
      setStatus(nextStatus);
    });

    return () => {
      unsubscribe();
    };
  }, []);

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

    return runUpdaterAction(() => window.electron.updaterCheckForUpdates());
  }, [runUpdaterAction, status]);

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

    return runUpdaterAction(() => window.electron.updaterDownloadUpdate());
  }, [runUpdaterAction, status]);

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

    return runUpdaterAction(() => window.electron.updaterQuitAndInstall());
  }, [runUpdaterAction, status]);

  return {
    status,
    actionError,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
  };
}
