import { moduleRegistry } from "./module-registry.js";
import { initializeModules } from "./index.js";

let platformReturnValue = "linux";
jest.mock("node:os", () => ({
  ...jest.requireActual("node:os"),
  platform: () => platformReturnValue,
}));

jest.mock("./module-registry.js", () => ({
  moduleRegistry: {
    register: jest.fn(),
  },
}));

jest.mock("./usb-capture/index.js", () => ({
  USBCaptureModule: jest.fn().mockImplementation(() => ({ name: "usb-capture" })),
}));

jest.mock("./decklink/index.js", () => ({
  DecklinkModule: jest.fn().mockImplementation(() => ({ name: "decklink" })),
}));

jest.mock("./display/index.js", () => ({
  DisplayModule: jest.fn().mockImplementation(() => ({ name: "display" })),
}));

describe("initializeModules", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    platformReturnValue = "linux";
  });

  it("registers USBCaptureModule on all platforms", () => {
    initializeModules();
    expect(moduleRegistry.register).toHaveBeenCalled();
    const usbCall = (moduleRegistry.register as jest.Mock).mock.calls.find(
      (call) => call[0]?.name === "usb-capture"
    );
    expect(usbCall).toBeDefined();
  });

  it("registers DecklinkModule only on darwin", () => {
    platformReturnValue = "darwin";
    initializeModules();
    const decklinkCall = (moduleRegistry.register as jest.Mock).mock.calls.find(
      (call) => call[0]?.name === "decklink"
    );
    expect(decklinkCall).toBeDefined();
  });

  it("does not register DecklinkModule on linux", () => {
    platformReturnValue = "linux";
    initializeModules();
    const decklinkCall = (moduleRegistry.register as jest.Mock).mock.calls.find(
      (call) => call[0]?.name === "decklink"
    );
    expect(decklinkCall).toBeUndefined();
  });

  it("registers DisplayModule on darwin and win32", () => {
    platformReturnValue = "darwin";
    initializeModules();
    const displayCall = (moduleRegistry.register as jest.Mock).mock.calls.find(
      (call) => call[0]?.name === "display"
    );
    expect(displayCall).toBeDefined();
  });

  it("does not register DisplayModule on linux", () => {
    platformReturnValue = "linux";
    initializeModules();
    const displayCall = (moduleRegistry.register as jest.Mock).mock.calls.find(
      (call) => call[0]?.name === "display"
    );
    expect(displayCall).toBeUndefined();
  });
});
