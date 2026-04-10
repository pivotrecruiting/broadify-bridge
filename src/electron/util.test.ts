jest.mock("./pathResolver.js", () => ({
  getUIPath: jest.fn(() => "/app/dist-react/index.html"),
}));

jest.mock("./services/env-loader.js", () => ({
  loadAppEnv: jest.fn(),
}));

const mockIpcMainHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  WebContents: Object,
  WebFrameMain: Object,
}));

import { isDev, validateEventFrame, ipcMainHandle, ipcWebContentsSend } from "./util.js";

const originalEnv = process.env;

describe("util", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("isDev", () => {
    it("returns true when NODE_ENV is development", () => {
      process.env.NODE_ENV = "development";
      expect(isDev()).toBe(true);
    });

    it("returns false when NODE_ENV is production", () => {
      process.env.NODE_ENV = "production";
      expect(isDev()).toBe(false);
    });
  });

  describe("validateEventFrame", () => {
    it("throws when frame url does not match UI path in production", () => {
      process.env.NODE_ENV = "production";
      const frame = {
        url: "file:///malicious/page.html",
      } as Electron.WebFrameMain;
      expect(() => validateEventFrame(frame)).toThrow("Malicious event");
    });

    it("allows frame when url matches UI path in production", () => {
      process.env.NODE_ENV = "production";
      const { getUIPath } = require("./pathResolver.js");
      getUIPath.mockReturnValue("/app/dist-react/index.html");
      const frame = {
        url: "file:///app/dist-react/index.html",
      } as Electron.WebFrameMain;
      expect(() => validateEventFrame(frame)).not.toThrow();
    });

    it("allows localhost in development", () => {
      process.env.NODE_ENV = "development";
      process.env.PORT = "5173";
      const frame = {
        url: "http://localhost:5173/",
      } as Electron.WebFrameMain;
      expect(() => validateEventFrame(frame)).not.toThrow();
    });

    it("throws when host is not localhost in development", () => {
      process.env.NODE_ENV = "development";
      process.env.PORT = "5173";
      const frame = {
        url: "file:///malicious/page.html",
      } as Electron.WebFrameMain;
      expect(() => validateEventFrame(frame)).toThrow("Malicious event");
    });
  });

  describe("ipcMainHandle", () => {
    beforeEach(() => {
      mockIpcMainHandle.mockClear();
    });

    it("registers handler that validates senderFrame when present", async () => {
      const handler = jest.fn().mockResolvedValue("result");
      ipcMainHandle("appGetVersion", handler);

      expect(mockIpcMainHandle).toHaveBeenCalledWith("appGetVersion", expect.any(Function));
      const registeredHandler = mockIpcMainHandle.mock.calls[0][1];

      const mockEvent = {
        senderFrame: {
          url: "file:///app/dist-react/index.html",
        },
      } as unknown as Electron.IpcMainInvokeEvent;

      const result = await registeredHandler(mockEvent);
      expect(handler).toHaveBeenCalledWith(mockEvent);
      expect(result).toBe("result");
    });

    it("throws when senderFrame has invalid url", () => {
      process.env.NODE_ENV = "production";
      const handler = jest.fn();
      ipcMainHandle("appGetVersion", handler);

      const registeredHandler = mockIpcMainHandle.mock.calls[0][1];
      const mockEvent = {
        senderFrame: {
          url: "file:///malicious/page.html",
        },
      } as unknown as Electron.IpcMainInvokeEvent;

      expect(() => registeredHandler(mockEvent)).toThrow("Malicious event");
      expect(handler).not.toHaveBeenCalled();
    });

    it("calls handler when senderFrame is null", async () => {
      const handler = jest.fn().mockResolvedValue("ok");
      ipcMainHandle("appGetVersion", handler);

      const registeredHandler = mockIpcMainHandle.mock.calls[0][1];
      const mockEvent = { senderFrame: null } as unknown as Electron.IpcMainInvokeEvent;

      const result = await registeredHandler(mockEvent);
      expect(handler).toHaveBeenCalledWith(mockEvent);
      expect(result).toBe("ok");
    });
  });

  describe("ipcWebContentsSend", () => {
    it("calls webContents.send with key and payload", () => {
      const send = jest.fn();
      const webContents = { send } as unknown as Electron.WebContents;

      ipcWebContentsSend("bridgeStatus", webContents, { running: true } as never);

      expect(send).toHaveBeenCalledWith("bridgeStatus", { running: true });
    });
  });
});
