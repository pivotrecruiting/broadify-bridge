import { openWebAppAfterStart } from "./open-web-app-after-start.js";

describe("openWebAppAfterStart", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("opens the web app exactly once when the start succeeded with a URL", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined);
    const opened = await openWebAppAfterStart(
      { success: true, webAppUrl: "https://app.example.test/" },
      openExternal,
    );
    expect(opened).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://app.example.test/");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("never opens the web app when the start failed", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined);
    const opened = await openWebAppAfterStart(
      { success: false, webAppUrl: "https://app.example.test/" },
      openExternal,
    );
    expect(opened).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("never opens the web app when the start result carries no URL", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined);
    const opened = await openWebAppAfterStart({ success: true }, openExternal);
    expect(opened).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("treats an empty URL string as no URL", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined);
    const opened = await openWebAppAfterStart(
      { success: true, webAppUrl: "" },
      openExternal,
    );
    expect(opened).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("swallows and logs a rejected openExternal", async () => {
    const failure = new Error("shell unavailable");
    const openExternal = jest.fn().mockRejectedValue(failure);
    await expect(
      openWebAppAfterStart(
        { success: true, webAppUrl: "https://app.example.test/" },
        openExternal,
      ),
    ).resolves.toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to open web app URL after start:",
      failure,
    );
  });
});
