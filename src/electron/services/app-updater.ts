import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";
import type { AppUpdaterActionResultT, AppUpdaterStatusT } from "../types.js";
import { autoUpdater } from "./electron-updater-loader.js";
import { logAppError, logAppInfo, logAppWarn } from "./app-logger.js";
import {
  sanitizeUpdaterErrorMessage,
  parseIntervalMs,
  getUpdaterDisableReason,
} from "./updater-utils.js";

type UpdaterStatusListenerT = (status: AppUpdaterStatusT) => void;

const STARTUP_CHECK_DELAY_MS = 15_000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Upper bound for pre-install cleanup: installing must never hang on a stuck
// helper shutdown, so the installer is started even if cleanup times out.
const INSTALL_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Service that owns desktop app auto-update state and lifecycle.
 */
class AppUpdaterService {
  private status: AppUpdaterStatusT = {
    enabled: false,
    state: "disabled",
    currentVersion: "unknown",
    availableVersion: null,
    downloadedVersion: null,
    channel: "latest",
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    lastCheckedAt: null,
    errorCode: null,
    message: "Auto-update is not initialized.",
  };

  private statusListener: UpdaterStatusListenerT | null = null;
  private installPreparationHook: (() => Promise<void>) | null = null;
  private installRequested = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  /**
   * Attach a listener and initialize auto-updater if supported.
   */
  public initialize(listener: UpdaterStatusListenerT): void {
    this.statusListener = listener;

    if (this.initialized) {
      this.emitStatus();
      return;
    }

    this.initialized = true;
    this.updateStatus({
      currentVersion: app.getVersion(),
      channel: this.resolveConfiguredChannel(),
    });

    const disableReason = this.getDisableReason();
    if (disableReason) {
      this.updateStatus({
        enabled: false,
        state: "disabled",
        message: disableReason,
      });
      logAppInfo(`[Updater] Disabled: ${disableReason}`);
      return;
    }

    this.configureAutoUpdater();
    this.registerAutoUpdaterEvents();

    this.updateStatus({
      enabled: true,
      state: "idle",
      message: `Auto-update is ready on channel ${this.status.channel}.`,
    });

    this.scheduleChecks();
  }

  /**
   * Return the current updater status snapshot.
   */
  public getStatus(): AppUpdaterStatusT {
    return { ...this.status };
  }

  /**
   * Trigger a manual update check.
   */
  public async checkForUpdates(): Promise<AppUpdaterActionResultT> {
    if (!this.status.enabled) {
      return this.failAction("Auto-update is disabled.");
    }

    if (this.status.state === "checking" || this.status.state === "downloading") {
      return this.failAction("Update check is already running.");
    }

    try {
      this.updateStatus({
        state: "checking",
        lastCheckedAt: new Date().toISOString(),
        errorCode: null,
        message: "Checking for updates...",
      });

      await autoUpdater.checkForUpdates();

      return {
        success: true,
        status: this.getStatus(),
      };
    } catch (error) {
      return this.handleUpdaterError(error, "check_for_updates_failed");
    }
  }

  /**
   * Trigger update download when an update is available.
   */
  public async downloadUpdate(): Promise<AppUpdaterActionResultT> {
    if (!this.status.enabled) {
      return this.failAction("Auto-update is disabled.");
    }

    if (this.status.state !== "available") {
      return this.failAction("No update available for download.");
    }

    try {
      this.updateStatus({
        state: "downloading",
        progressPercent: 0,
        bytesPerSecond: null,
        transferredBytes: 0,
        totalBytes: null,
        errorCode: null,
        message: "Downloading update...",
      });

      await autoUpdater.downloadUpdate();

      return {
        success: true,
        status: this.getStatus(),
      };
    } catch (error) {
      return this.handleUpdaterError(error, "download_update_failed");
    }
  }

  /**
   * Quit the app and install a downloaded update.
   */
  /**
   * Register the hook that tears down child processes and releases the quit
   * guard before the installer runs. Installing requires a NORMAL app quit
   * (Squirrel closes windows on macOS, NSIS calls app.quit() on Windows);
   * the app's own close/before-quit handlers must stand down for it.
   */
  public setInstallPreparationHook(hook: () => Promise<void>): void {
    this.installPreparationHook = hook;
  }

  public quitAndInstall(): AppUpdaterActionResultT {
    if (!this.status.enabled) {
      return this.failAction("Auto-update is disabled.");
    }

    if (this.status.state !== "downloaded") {
      return this.failAction("No downloaded update is ready to install.");
    }

    if (this.installRequested) {
      return this.failAction("Update installation is already in progress.");
    }
    this.installRequested = true;

    this.updateStatus({
      message: "Installing update and restarting app...",
    });

    setImmediate(() => {
      void (async () => {
        try {
          const hook = this.installPreparationHook;
          if (hook) {
            // Cleanup must never block the install indefinitely.
            await Promise.race([
              hook(),
              new Promise<void>((resolve) =>
                setTimeout(resolve, INSTALL_CLEANUP_TIMEOUT_MS),
              ),
            ]);
          }
        } catch (error) {
          logAppWarn(
            `[Updater] Pre-install cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        autoUpdater.quitAndInstall(false, true);
      })();
    });

    return {
      success: true,
      status: this.getStatus(),
    };
  }

  /**
   * Stop internal timers and detach listeners.
   */
  public shutdown(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    this.statusListener = null;
  }

  /**
   * Resolve why auto-update should be disabled in this runtime.
   */
  private getDisableReason(): string | null {
    return getUpdaterDisableReason({
      disableEnv: process.env.BROADIFY_DISABLE_AUTO_UPDATE,
      platform: process.platform,
      isPackaged: app.isPackaged,
      appImage: process.env.APPIMAGE,
    });
  }

  /**
   * Configure autoUpdater defaults and request headers.
   */
  /**
   * Resolve the update channel: an explicit env override wins; packaged
   * builds otherwise carry their channel in app-update.yml (an RC build has
   * no env var at runtime and must not silently fall back to "latest").
   */
  private resolveConfiguredChannel(): string {
    const envChannel = process.env.BROADIFY_UPDATER_CHANNEL?.trim();
    if (envChannel) {
      return envChannel;
    }
    try {
      const updateConfigPath = join(process.resourcesPath ?? "", "app-update.yml");
      const match = readFileSync(updateConfigPath, "utf8").match(/^channel:\s*['"]?([\w.-]+)/m);
      if (match) {
        return match[1];
      }
    } catch {
      // Unpackaged/dev runs have no app-update.yml.
    }
    return "latest";
  }

  private configureAutoUpdater(): void {
    // Route electron-updater logs into the app log so support can diagnose
    // stuck checks/downloads/installs from the log file.
    autoUpdater.logger = {
      info: (message: unknown) => logAppInfo(`[Updater] ${String(message)}`),
      warn: (message: unknown) => logAppWarn(`[Updater] ${String(message)}`),
      error: (message: unknown) => logAppError(`[Updater] ${String(message)}`),
      debug: (message: unknown) => logAppInfo(`[Updater:debug] ${String(message)}`),
    };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.channel = this.status.channel;
    autoUpdater.allowPrerelease = this.status.channel !== "latest";
    autoUpdater.allowDowngrade = false;

    const githubToken = process.env.BROADIFY_UPDATER_GITHUB_TOKEN?.trim();
    if (githubToken) {
      autoUpdater.requestHeaders = {
        ...(autoUpdater.requestHeaders || {}),
        Authorization: `token ${githubToken}`,
      };
    }
  }

  /**
   * Register updater event listeners and keep a status snapshot in sync.
   */
  private registerAutoUpdaterEvents(): void {
    autoUpdater.on("checking-for-update", () => {
      this.updateStatus({
        state: "checking",
        lastCheckedAt: new Date().toISOString(),
        errorCode: null,
        message: "Checking for updates...",
      });
      logAppInfo("[Updater] Checking for updates");
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      if (
        this.status.state === "downloaded" &&
        this.status.downloadedVersion === info.version
      ) {
        // Periodic re-checks must not clobber an already-downloaded update
        // back into the "available" state (users had to re-download).
        logAppInfo(
          `[Updater] Update ${info.version} already downloaded; keeping install-ready state`,
        );
        return;
      }
      this.updateStatus({
        state: "available",
        availableVersion: info.version,
        downloadedVersion: null,
        progressPercent: 0,
        bytesPerSecond: null,
        transferredBytes: 0,
        totalBytes: null,
        errorCode: null,
        message: `Update ${info.version} is available.`,
      });
      logAppInfo(`[Updater] Update available: ${info.version}`);
    });

    autoUpdater.on("update-not-available", () => {
      this.updateStatus({
        state: "not_available",
        availableVersion: null,
        downloadedVersion: null,
        progressPercent: null,
        bytesPerSecond: null,
        transferredBytes: null,
        totalBytes: null,
        errorCode: null,
        message: "App is up to date.",
      });
      logAppInfo("[Updater] No update available");
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.updateStatus({
        state: "downloading",
        progressPercent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
        errorCode: null,
        message: `Downloading update (${progress.percent.toFixed(1)}%).`,
      });
    });

    autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
      this.updateStatus({
        state: "downloaded",
        downloadedVersion: info.version,
        progressPercent: 100,
        bytesPerSecond: null,
        transferredBytes: this.status.totalBytes,
        totalBytes: this.status.totalBytes,
        errorCode: null,
        message: `Update ${info.version} downloaded. Restart to install.`,
      });
      logAppInfo(`[Updater] Update downloaded: ${info.version}`);
    });

    autoUpdater.on("error", (error: Error) => {
      const message = sanitizeUpdaterErrorMessage(error.message);
      this.updateStatus({
        state: "error",
        errorCode: "updater_error",
        message,
      });
      logAppError(`[Updater] ${message}`);
    });
  }

  /**
   * Schedule one startup check and periodic checks.
   */
  private scheduleChecks(): void {
    this.startupTimer = setTimeout(() => {
      void this.checkForUpdates();
    }, STARTUP_CHECK_DELAY_MS);

    const intervalMs = parseIntervalMs(
      process.env.BROADIFY_UPDATER_CHECK_INTERVAL_MS,
      DEFAULT_CHECK_INTERVAL_MS,
    );

    this.periodicTimer = setInterval(() => {
      void this.checkForUpdates();
    }, intervalMs);

    logAppInfo(
      `[Updater] Automatic checks scheduled every ${Math.round(intervalMs / 60000)} minutes`,
    );
  }

  /**
   * Emit a status snapshot to the registered listener.
   */
  private emitStatus(): void {
    if (!this.statusListener) {
      return;
    }
    this.statusListener({ ...this.status });
  }

  /**
   * Patch status fields and emit updates.
   */
  private updateStatus(patch: Partial<AppUpdaterStatusT>): void {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.emitStatus();
  }

  /**
   * Build a failed action result while preserving current status.
   */
  private failAction(error: string): AppUpdaterActionResultT {
    return {
      success: false,
      error,
      status: this.getStatus(),
    };
  }

  /**
   * Normalize updater errors and publish state.
   */
  private handleUpdaterError(
    error: unknown,
    errorCode: string,
  ): AppUpdaterActionResultT {
    const rawMessage = error instanceof Error ? error.message : "Unknown updater error";
    const message = sanitizeUpdaterErrorMessage(rawMessage);

    this.updateStatus({
      state: "error",
      errorCode,
      message,
    });

    logAppWarn(`[Updater] ${errorCode}: ${message}`);

    return {
      success: false,
      error: message,
      status: this.getStatus(),
    };
  }
}

export const appUpdaterService = new AppUpdaterService();
