import * as fs from "node:fs";
import { logRuntimeDiagnostics } from "./runtime-diagnostics.js";

jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  existsSync: jest.fn(),
  statSync: jest.fn(),
  accessSync: jest.fn(),
}));

jest.mock("../modules/decklink/decklink-helper.js", () => ({
  resolveDecklinkHelperPath: () => "/tmp/decklink-helper",
}));

jest.mock("../modules/display/display-helper.js", () => ({
  resolveDisplayHelperPath: () => "/tmp/display-helper",
}));

jest.mock("./graphics/framebus/framebus-client.js", () => ({
  resolveFrameBusNativeCandidates: () => ["/tmp/framebus.node"],
}));

describe("runtime-diagnostics", () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.statSync as jest.Mock).mockReturnValue({ size: 1024, mode: 0o755 });
    (fs.accessSync as jest.Mock).mockImplementation(() => undefined);
  });

  it("logs runtime context", () => {
    logRuntimeDiagnostics(mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("[RuntimeDiagnostics] Context")
    );
  });

  it("logs bridge entry check", () => {
    logRuntimeDiagnostics(mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Bridge entry")
    );
  });

  it("logs DeckLink helper check", () => {
    logRuntimeDiagnostics(mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("DeckLink helper")
    );
  });

  it("logs FrameBus candidates", () => {
    logRuntimeDiagnostics(mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus candidate")
    );
  });

  it("reports missing when artifact does not exist", () => {
    (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
      !String(p).includes("index.js")
    );
    logRuntimeDiagnostics(mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Bridge entry: missing/)
    );
  });
});
