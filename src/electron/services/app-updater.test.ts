/**
 * Tests for AppUpdaterService (app-updater.ts).
 */

const mockListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
const mockOn = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
  if (!mockListeners[event]) mockListeners[event] = [];
  mockListeners[event].push(handler);
});
const mockCheckForUpdates = jest.fn().mockResolvedValue(undefined);
const mockDownloadUpdate = jest.fn().mockResolvedValue(undefined);
const mockQuitAndInstall = jest.fn();

const mockAutoUpdater = {
  on: mockOn,
  checkForUpdates: mockCheckForUpdates,
  downloadUpdate: mockDownloadUpdate,
  quitAndInstall: mockQuitAndInstall,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  channel: "latest",
  allowPrerelease: false,
  allowDowngrade: false,
  requestHeaders: undefined as Record<string, string> | undefined,
};

jest.mock("electron", () => ({
  app: {
    getVersion: jest.fn().mockReturnValue("1.0.0"),
    isPackaged: true,
  },
}));

jest.mock("./electron-updater-loader.js", () => ({
  autoUpdater: mockAutoUpdater,
}));

const mockGetUpdaterDisableReason = jest.fn().mockReturnValue(null);
const mockParseIntervalMs = jest.fn((_v: string | undefined, fallback: number) => fallback);
const mockSanitizeUpdaterErrorMessage = jest.fn((msg: string) => msg);

jest.mock("./updater-utils.js", () => ({
  getUpdaterDisableReason: (...args: unknown[]) => mockGetUpdaterDisableReason(...args),
  parseIntervalMs: (...args: unknown[]) => mockParseIntervalMs(...args),
  sanitizeUpdaterErrorMessage: (...args: unknown[]) => mockSanitizeUpdaterErrorMessage(...args),
}));

const mockLogAppError = jest.fn();
const mockLogAppInfo = jest.fn();
const mockLogAppWarn = jest.fn();

jest.mock("./app-logger.js", () => ({
  logAppError: (...args: unknown[]) => mockLogAppError(...args),
  logAppInfo: (...args: unknown[]) => mockLogAppInfo(...args),
  logAppWarn: (...args: unknown[]) => mockLogAppWarn(...args),
}));

function emit(event: string, ...args: unknown[]): void {
  (mockListeners[event] || []).forEach((h) => h(...args));
}

describe("AppUpdaterService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetUpdaterDisableReason.mockReturnValue(null);
    mockParseIntervalMs.mockImplementation((_v: string | undefined, fallback: number) => fallback);
    mockSanitizeUpdaterErrorMessage.mockImplementation((msg: string) => msg);
    mockCheckForUpdates.mockResolvedValue(undefined);
    mockDownloadUpdate.mockResolvedValue(undefined);
    Object.keys(mockListeners).forEach((k) => delete mockListeners[k]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("initialize", () => {
    it("sets listener and configures updater when not disabled", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          state: "idle",
          currentVersion: "1.0.0",
          channel: "latest",
          message: expect.stringContaining("ready"),
        }),
      );
      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
      expect(mockAutoUpdater.channel).toBe("latest");
      expect(mockOn).toHaveBeenCalledWith("checking-for-update", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("update-available", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("update-not-available", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("download-progress", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("update-downloaded", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mockLogAppInfo).toHaveBeenCalledWith(
        expect.stringMatching(/Automatic checks scheduled/),
      );
    });

    it("sets disabled state and message when getUpdaterDisableReason returns reason", async () => {
      mockGetUpdaterDisableReason.mockReturnValue("Disabled by BROADIFY_DISABLE_AUTO_UPDATE=1.");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          state: "disabled",
          message: "Disabled by BROADIFY_DISABLE_AUTO_UPDATE=1.",
        }),
      );
      expect(mockLogAppInfo).toHaveBeenCalledWith(
        "[Updater] Disabled: Disabled by BROADIFY_DISABLE_AUTO_UPDATE=1.",
      );
      expect(mockOn).not.toHaveBeenCalled();
    });

    it("calls getUpdaterDisableReason with app context", async () => {
      const { app } = await import("electron");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());

      expect(mockGetUpdaterDisableReason).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: process.platform,
          isPackaged: app.isPackaged,
        }),
      );
    });

    it("on second initialize only emits status without re-registering", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      const callCount = listener.mock.calls.length;
      mockOn.mockClear();
      appUpdaterService.initialize(listener);

      expect(listener.mock.calls.length).toBeGreaterThan(callCount);
      expect(mockOn).not.toHaveBeenCalled();
    });

    it("sets requestHeaders when BROADIFY_UPDATER_GITHUB_TOKEN is set", async () => {
      const orig = process.env.BROADIFY_UPDATER_GITHUB_TOKEN;
      process.env.BROADIFY_UPDATER_GITHUB_TOKEN = "ghp_secret123";
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());

      expect(mockAutoUpdater.requestHeaders).toEqual(
        expect.objectContaining({ Authorization: "token ghp_secret123" }),
      );
      process.env.BROADIFY_UPDATER_GITHUB_TOKEN = orig;
    });

    it("uses BROADIFY_UPDATER_CHANNEL for channel when set", async () => {
      const orig = process.env.BROADIFY_UPDATER_CHANNEL;
      process.env.BROADIFY_UPDATER_CHANNEL = " beta ";
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "beta" }),
      );
      expect(mockAutoUpdater.channel).toBe("beta");
      expect(mockAutoUpdater.allowPrerelease).toBe(true);
      process.env.BROADIFY_UPDATER_CHANNEL = orig;
    });
  });

  describe("getStatus", () => {
    it("returns a copy of current status", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const a = appUpdaterService.getStatus();
      const b = appUpdaterService.getStatus();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });

  describe("checkForUpdates", () => {
    it("returns fail when updater is disabled", async () => {
      mockGetUpdaterDisableReason.mockReturnValue("Disabled.");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = await appUpdaterService.checkForUpdates();
      expect(result.success).toBe(false);
      expect(result.error).toContain("disabled");
      expect(mockCheckForUpdates).not.toHaveBeenCalled();
    });

    it("returns fail when state is checking", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      void appUpdaterService.checkForUpdates();
      await Promise.resolve();
      const result = await appUpdaterService.checkForUpdates();
      expect(result.success).toBe(false);
      expect(result.error).toContain("already running");
    });

    it("sets checking and calls autoUpdater.checkForUpdates then returns success", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      const resultPromise = appUpdaterService.checkForUpdates();
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "checking", message: "Checking for updates..." }),
      );
      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.status).toBeDefined();
      expect(mockCheckForUpdates).toHaveBeenCalled();
    });

    it("on throw calls handleUpdaterError and returns fail", async () => {
      mockCheckForUpdates.mockRejectedValueOnce(new Error("Network error"));
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = await appUpdaterService.checkForUpdates();
      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
      expect(mockLogAppWarn).toHaveBeenCalledWith(
        expect.stringContaining("check_for_updates_failed"),
      );
    });

    it("sanitizes error message in handleUpdaterError", async () => {
      mockCheckForUpdates.mockRejectedValueOnce(new Error("token ghp_xxx"));
      mockSanitizeUpdaterErrorMessage.mockReturnValue("token [REDACTED]");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = await appUpdaterService.checkForUpdates();
      expect(result.success).toBe(false);
      expect(result.error).toBe("token [REDACTED]");
    });
  });

  describe("downloadUpdate", () => {
    it("returns fail when disabled", async () => {
      mockGetUpdaterDisableReason.mockReturnValue("Disabled.");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = await appUpdaterService.downloadUpdate();
      expect(result.success).toBe(false);
      expect(mockDownloadUpdate).not.toHaveBeenCalled();
    });

    it("returns fail when state is not available", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = await appUpdaterService.downloadUpdate();
      expect(result.success).toBe(false);
      expect(result.error).toContain("No update available");
    });

    it("when state is available sets downloading and calls downloadUpdate", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("update-available", { version: "2.0.0" });
      const resultPromise = appUpdaterService.downloadUpdate();
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "downloading",
          progressPercent: 0,
          message: "Downloading update...",
        }),
      );
      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(mockDownloadUpdate).toHaveBeenCalled();
    });

    it("on downloadUpdate throw returns fail", async () => {
      mockDownloadUpdate.mockRejectedValueOnce(new Error("Download failed"));
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("update-available", { version: "2.0.0" });
      const result = await appUpdaterService.downloadUpdate();
      expect(result.success).toBe(false);
      expect(result.error).toBe("Download failed");
    });
  });

  describe("quitAndInstall", () => {
    it("returns fail when disabled", async () => {
      mockGetUpdaterDisableReason.mockReturnValue("Disabled.");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = appUpdaterService.quitAndInstall();
      expect(result.success).toBe(false);
      expect(mockQuitAndInstall).not.toHaveBeenCalled();
    });

    it("returns fail when state is not downloaded", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = appUpdaterService.quitAndInstall();
      expect(result.success).toBe(false);
      expect(result.error).toContain("No downloaded update");
    });

    it("when downloaded updates status and returns success; schedules quitAndInstall via setImmediate", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("update-available", { version: "2.0.0" });
      await appUpdaterService.downloadUpdate();
      emit("update-downloaded", { version: "2.0.0" });
      const result = appUpdaterService.quitAndInstall();
      expect(result.success).toBe(true);
      expect(result.status.state).toBe("downloaded");
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "Installing update and restarting app..." }),
      );
    });
  });

  describe("shutdown", () => {
    it("clears timers and listener", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      appUpdaterService.shutdown();
      jest.advanceTimersByTime(20_000);
      expect(listener).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: "checking" }),
      );
    });
  });

  describe("autoUpdater events", () => {
    it("checking-for-update updates status", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("checking-for-update");
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "checking",
          message: "Checking for updates...",
        }),
      );
      expect(mockLogAppInfo).toHaveBeenCalledWith("[Updater] Checking for updates");
    });

    it("update-available sets state and version", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("update-available", { version: "2.0.0" });
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "available",
          availableVersion: "2.0.0",
          message: "Update 2.0.0 is available.",
        }),
      );
      expect(mockLogAppInfo).toHaveBeenCalledWith("[Updater] Update available: 2.0.0");
    });

    it("update-not-available sets state", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("update-not-available");
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "not_available",
          message: "App is up to date.",
        }),
      );
      expect(mockLogAppInfo).toHaveBeenCalledWith("[Updater] No update available");
    });

    it("download-progress updates status", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("download-progress", {
        percent: 50,
        bytesPerSecond: 1000,
        transferred: 5000,
        total: 10000,
      });
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "downloading",
          progressPercent: 50,
          bytesPerSecond: 1000,
          transferredBytes: 5000,
          totalBytes: 10000,
          message: expect.stringContaining("50.0"),
        }),
      );
    });

    it("update-downloaded sets state and version", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("update-available", { version: "2.0.0" });
      await appUpdaterService.downloadUpdate();
      emit("download-progress", { percent: 100, transferred: 100, total: 100 });
      emit("update-downloaded", { version: "2.0.0" });
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "downloaded",
          downloadedVersion: "2.0.0",
          progressPercent: 100,
          message: expect.stringContaining("Update 2.0.0 downloaded"),
        }),
      );
      expect(mockLogAppInfo).toHaveBeenCalledWith("[Updater] Update downloaded: 2.0.0");
    });

    it("error event updates status and logs", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      const listener = jest.fn();
      appUpdaterService.initialize(listener);
      emit("error", new Error("Updater failed"));
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "error",
          errorCode: "updater_error",
          message: "Updater failed",
        }),
      );
      expect(mockLogAppError).toHaveBeenCalledWith("[Updater] Updater failed");
    });
  });

  describe("scheduleChecks", () => {
    it("schedules startup check after STARTUP_CHECK_DELAY_MS", async () => {
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      expect(mockCheckForUpdates).not.toHaveBeenCalled();
      jest.advanceTimersByTime(14_999);
      await Promise.resolve();
      expect(mockCheckForUpdates).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2);
      await Promise.resolve();
      expect(mockCheckForUpdates).toHaveBeenCalled();
    });

    it("uses parseIntervalMs for periodic interval", async () => {
      mockParseIntervalMs.mockReturnValue(60_000);
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      expect(mockParseIntervalMs).toHaveBeenCalledWith(
        process.env.BROADIFY_UPDATER_CHECK_INTERVAL_MS,
        expect.any(Number),
      );
      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleUpdaterError with non-Error", () => {
    it("uses generic message for non-Error throw", async () => {
      mockCheckForUpdates.mockRejectedValueOnce("string error");
      jest.resetModules();
      const { appUpdaterService } = await import("./app-updater.js");
      appUpdaterService.initialize(jest.fn());
      const result = await appUpdaterService.checkForUpdates();
      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown updater error");
    });
  });
});
