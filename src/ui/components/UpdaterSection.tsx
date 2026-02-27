import type { AppUpdaterStatusT } from "@broadify/protocol";
import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";

interface UpdaterSectionProps {
  status: AppUpdaterStatusT;
  actionError: string | null;
  onCheckForUpdates: () => Promise<unknown>;
  onDownloadUpdate: () => Promise<unknown>;
  onQuitAndInstall: () => Promise<unknown>;
}

/**
 * Displays updater status and user actions for app updates.
 */
export function UpdaterSection({
  status,
  actionError,
  onCheckForUpdates,
  onDownloadUpdate,
  onQuitAndInstall,
}: UpdaterSectionProps) {
  const statusText = getStatusText(status);
  const progressText =
    status.state === "downloading" && status.progressPercent !== null
      ? `${status.progressPercent.toFixed(1)}%`
      : null;

  const isBusy = status.state === "checking" || status.state === "downloading";
  const canDownload = status.enabled && status.state === "available";
  const canInstall = status.enabled && status.state === "downloaded";
  const canCheck = status.enabled && !isBusy;

  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4 md:gap-6 items-start">
        <div className="space-y-1">
          <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
            Updates
          </h2>
          <span className="text-xs text-muted-foreground">
            Current version {status.currentVersion || "-"}
          </span>
        </div>

        <div className="space-y-3">
          <div className="text-sm text-card-foreground">{statusText}</div>

          {progressText ? (
            <div className="text-xs text-muted-foreground">Download: {progressText}</div>
          ) : null}

          {status.availableVersion ? (
            <div className="text-xs text-muted-foreground">
              Available version: {status.availableVersion}
            </div>
          ) : null}

          {actionError ? (
            <div className="text-xs text-destructive">{actionError}</div>
          ) : null}

          <div className="flex flex-wrap gap-2">
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
        </div>
      </div>
    </Card>
  );
}

/**
 * Resolve human-readable updater text from updater status.
 */
function getStatusText(status: AppUpdaterStatusT): string {
  switch (status.state) {
    case "disabled":
      return status.message || "Auto-update is disabled.";
    case "idle":
      return status.message || "Auto-update is ready.";
    case "checking":
      return status.message || "Checking for updates...";
    case "available":
      return status.message || "Update available.";
    case "not_available":
      return status.message || "App is up to date.";
    case "downloading":
      return status.message || "Downloading update...";
    case "downloaded":
      return status.message || "Update downloaded. Restart to install.";
    case "error":
      return status.message || "Update check failed.";
    default:
      return "Unknown updater state.";
  }
}
