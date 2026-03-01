import { useEffect } from "react";
import type { AppUpdaterStatusT } from "@broadify/protocol";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UpdaterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  status: AppUpdaterStatusT;
  actionError: string | null;
  onCheckForUpdates: () => Promise<unknown>;
  onDownloadUpdate: () => Promise<unknown>;
  onQuitAndInstall: () => Promise<unknown>;
}

/**
 * Dialog to inspect updater state and trigger update actions.
 */
export function UpdaterDialog({
  isOpen,
  onClose,
  status,
  actionError,
  onCheckForUpdates,
  onDownloadUpdate,
  onQuitAndInstall,
}: UpdaterDialogProps) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const isBusy = status.state === "checking" || status.state === "downloading";
  const canCheck = status.enabled && !isBusy;
  const canDownload = status.enabled && status.state === "available";
  const canInstall = status.enabled && status.state === "downloaded";
  const isUpdateAvailable = status.state === "available";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="fixed inset-0 bg-white/55 backdrop-blur-sm" />

      <div className="relative w-full max-w-lg rounded-xl glass-frosted border border-white/20 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <h2 className="text-xl font-bold text-foreground">
            {isUpdateAvailable ? "Software update available" : "App Updates"}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-white/10 transition-colors text-foreground hover:text-foreground/80"
            aria-label="Close updates"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {isUpdateAvailable ? (
            <div className="rounded-lg border border-primary/20 bg-primary/10 p-4">
              <div className="space-y-1">
                <p className="text-base font-semibold text-foreground">
                  Version {status.availableVersion || "unknown"} is ready to download.
                </p>
                <p className="text-sm text-muted-foreground">
                  Download the latest release now, or keep using the current version and install it later.
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">Current version</span>
            <span className="text-foreground text-right">{status.currentVersion || "-"}</span>

            <span className="text-muted-foreground">State</span>
            <span className="text-foreground text-right">{status.state}</span>

            <span className="text-muted-foreground">Channel</span>
            <span className="text-foreground text-right">{status.channel || "latest"}</span>

            <span className="text-muted-foreground">Available version</span>
            <span className="text-foreground text-right">{status.availableVersion || "-"}</span>

            <span className="text-muted-foreground">Downloaded version</span>
            <span className="text-foreground text-right">{status.downloadedVersion || "-"}</span>

            <span className="text-muted-foreground">Last check</span>
            <span className="text-foreground text-right">{formatTimestamp(status.lastCheckedAt)}</span>
          </div>

          {status.state === "downloading" && status.progressPercent !== null ? (
            <div className="space-y-1">
              <div className="h-2 w-full rounded-full bg-white/20 overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${Math.max(0, Math.min(status.progressPercent, 100))}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground text-right">
                {status.progressPercent.toFixed(1)}%
              </div>
            </div>
          ) : null}

          <div className="text-sm text-foreground">{status.message || "No updater message."}</div>

          {actionError ? <div className="text-sm text-destructive">{actionError}</div> : null}

          {isUpdateAvailable ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={onClose}
              >
                Install later
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void onDownloadUpdate();
                }}
                disabled={!canDownload}
              >
                Update now
              </Button>
            </div>
          ) : null}

          {!isUpdateAvailable ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void onCheckForUpdates();
                }}
                disabled={!canCheck}
              >
                Check
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void onDownloadUpdate();
                }}
                disabled={!canDownload}
              >
                Download
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void onQuitAndInstall();
                }}
                disabled={!canInstall}
              >
                Restart and install
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Format an ISO timestamp for dialog display.
 */
function formatTimestamp(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}
