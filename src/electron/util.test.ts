jest.mock("./pathResolver.js", () => ({
  getUIPath: jest.fn(() => "/app/dist-react/index.html"),
}));

jest.mock("./services/env-loader.js", () => ({
  loadAppEnv: jest.fn(),
}));

import { isDev, validateEventFrame } from "./util.js";

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

    it("allows localhost in development", () => {
      process.env.NODE_ENV = "development";
      process.env.PORT = "5173";
      const frame = {
        url: "http://localhost:5173/",
      } as Electron.WebFrameMain;
      expect(() => validateEventFrame(frame)).not.toThrow();
    });
  });
});
