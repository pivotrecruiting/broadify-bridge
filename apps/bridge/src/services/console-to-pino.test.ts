import { bindConsoleToLogger } from "./console-to-pino.js";

describe("bindConsoleToLogger", () => {
  const originalConsole = { ...console };
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    bindConsoleToLogger(mockLogger);
  });

  afterAll(() => {
    Object.assign(console, originalConsole);
  });

  it("redirects console.log to logger.info", () => {
    console.log("hello");
    expect(mockLogger.info).toHaveBeenCalledWith("hello");
  });

  it("redirects console.info to logger.info", () => {
    console.info("info message");
    expect(mockLogger.info).toHaveBeenCalledWith("info message");
  });

  it("redirects console.warn to logger.warn", () => {
    console.warn("warning");
    expect(mockLogger.warn).toHaveBeenCalledWith("warning");
  });

  it("redirects console.error to logger.error", () => {
    console.error("error");
    expect(mockLogger.error).toHaveBeenCalledWith("error");
  });

  it("redirects console.debug to logger.debug when available", () => {
    console.debug("debug");
    expect(mockLogger.debug).toHaveBeenCalledWith("debug");
  });

  it("falls back to logger.info when debug is not available", () => {
    const loggerWithoutDebug = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    bindConsoleToLogger(loggerWithoutDebug);
    console.debug("fallback");
    expect(loggerWithoutDebug.info).toHaveBeenCalledWith("fallback");
  });

  it("formats Error objects with stack", () => {
    const err = new Error("test");
    err.stack = "Error: test\n  at foo";
    console.error(err);
    expect(mockLogger.error).toHaveBeenCalledWith("Error: test\n  at foo");
  });

  it("formats multiple args as space-joined string", () => {
    console.log("a", "b", 1);
    expect(mockLogger.info).toHaveBeenCalledWith("a b 1");
  });
});
