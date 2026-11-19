import type { DeviceDescriptorT } from "@broadify/protocol";
import type { DeviceController, DeviceModule } from "../modules/device-module.js";
import { buildBridgeOutputsView } from "./outputs-view.js";

const makeDecklinkDevice = (
  overrides: Partial<DeviceDescriptorT> = {},
): DeviceDescriptorT => ({
  id: "deck-1",
  displayName: "DeckLink",
  type: "decklink",
  ports: [
    {
      id: "port-fill",
      displayName: "SDI Fill",
      type: "sdi",
      role: "fill",
      direction: "output",
      status: { available: true },
      capabilities: { formats: [], modes: [] },
    },
    {
      id: "port-key",
      displayName: "SDI Key",
      type: "sdi",
      role: "key",
      direction: "output",
      status: { available: true },
      capabilities: { formats: [], modes: [] },
    },
  ],
  status: { present: true, inUse: false, ready: true, lastSeen: Date.now() },
  ...overrides,
});

const makeDeps = (
  options: {
    output1Id?: string;
    output2Id?: string;
    decklinkModule?: DeviceModule;
    displayModule?: DeviceModule;
    platform?: NodeJS.Platform;
  } = {},
) => ({
  graphicsManager: {
    getStatus: () => ({
      outputConfig: {
        targets: {
          output1Id: options.output1Id,
          output2Id: options.output2Id,
        },
      },
    }),
  },
  moduleRegistry: {
    getModule: (moduleName: string) =>
      moduleName === "decklink"
        ? options.decklinkModule
        : moduleName === "display"
          ? options.displayModule
          : undefined,
  },
  platform: options.platform ?? "darwin",
});

const createController = (): DeviceController => ({
  open: jest.fn(),
  close: jest.fn(),
  getStatus: jest.fn().mockResolvedValue({
    present: true,
    ready: true,
    inUse: false,
    lastSeen: Date.now(),
  }),
});

const decklinkModule = (
  diagnostics?: DeviceModule["getLastDiagnostics"],
): DeviceModule => ({
    name: "decklink",
    detect: jest.fn().mockResolvedValue([]),
    createController,
    getLastDiagnostics: diagnostics,
  });

const displayModule = (
  diagnostics?: DeviceModule["getLastDiagnostics"],
): DeviceModule => ({
  name: "display",
  detect: jest.fn().mockResolvedValue([]),
  createController,
  getLastDiagnostics: diagnostics,
});

const makeDisplayDevice = (): DeviceDescriptorT => ({
  id: "display-1",
  displayName: "HDMI Monitor",
  type: "display",
  ports: [
    {
      id: "display-port-1",
      displayName: "HDMI",
      type: "hdmi",
      role: "fill",
      direction: "output",
      status: { available: true },
      capabilities: { formats: [], modes: [] },
    },
  ],
  status: { present: true, inUse: false, ready: true, lastSeen: Date.now() },
});

describe("buildBridgeOutputsView", () => {
  it("marks configured output ports as owned and available", () => {
    const result = buildBridgeOutputsView(
      [
        makeDecklinkDevice({
          status: {
            present: true,
            inUse: true,
            ready: false,
            lastSeen: Date.now(),
          },
          ports: [
            {
              id: "port-fill",
              displayName: "SDI Fill",
              type: "sdi",
              role: "fill",
              direction: "output",
              status: { available: false },
              capabilities: { formats: [], modes: [] },
            },
            {
              id: "port-key",
              displayName: "SDI Key",
              type: "sdi",
              role: "key",
              direction: "output",
              status: { available: false },
              capabilities: { formats: [], modes: [] },
            },
          ],
        }),
      ],
      makeDeps({
        output1Id: "port-fill",
        output2Id: "port-key",
        decklinkModule: decklinkModule(),
      }),
    );

    expect(result).toMatchObject({
      output1: [{ id: "port-fill", available: true, ownedByBridge: true }],
      output2: [{ id: "port-key", available: true, ownedByBridge: true }],
    });
  });

  it("attaches DeckLink diagnostics from the registered module", () => {
    const result = buildBridgeOutputsView(
      [makeDecklinkDevice()],
      makeDeps({
        decklinkModule: decklinkModule(() => ({
          kind: "decklink",
          apiAvailable: true,
          apiVersion: "12.8",
          helperVersion: "0.1.0",
          message: "ready",
        })),
      }),
    );

    expect(result.diagnostics).toEqual({
      platform: "darwin",
      decklink: {
        state: "ok",
        apiVersion: "12.8",
        helperVersion: "0.1.0",
        message: "ready",
      },
    });
  });

  it("reports unsupported_platform when the DeckLink module is missing", () => {
    const result = buildBridgeOutputsView(
      [makeDecklinkDevice()],
      makeDeps({ platform: "win32" }),
    );

    expect(result.diagnostics).toEqual({
      platform: "win32",
      decklink: { state: "unsupported_platform" },
    });
    expect(result.diagnostics && "display" in result.diagnostics).toBe(false);
  });

  it("includes display diagnostics from the display module", () => {
    const result = buildBridgeOutputsView(
      [],
      makeDeps({
        platform: "win32",
        displayModule: displayModule(() => ({
          kind: "display",
          state: "missing_runtime",
          message:
            "Native display helper could not start (STATUS_DLL_NOT_FOUND). The Microsoft Visual C++ runtime is missing; install vc_redist.x64 or reinstall the bridge.",
          exitCode: 3_221_225_781,
        })),
      }),
    );

    expect(result.diagnostics).toEqual({
      platform: "win32",
      decklink: { state: "unsupported_platform" },
      display: {
        state: "missing_runtime",
        message:
          "Native display helper could not start (STATUS_DLL_NOT_FOUND). The Microsoft Visual C++ runtime is missing; install vc_redist.x64 or reinstall the bridge.",
        exitCode: 3_221_225_781,
      },
    });
    expect(result.diagnostics?.display).not.toHaveProperty("kind");
  });

  it("derives display ok from the device list when the module has no diagnostics yet", () => {
    const result = buildBridgeOutputsView(
      [makeDisplayDevice()],
      makeDeps({
        platform: "darwin",
        decklinkModule: decklinkModule(() => ({ kind: "decklink", apiAvailable: true })),
        displayModule: displayModule(() => null),
      }),
    );

    expect(result.diagnostics).toEqual({
      platform: "darwin",
      decklink: { state: "no_devices" },
      display: { state: "ok" },
    });
  });

  it("ignores diagnostics of the wrong kind", () => {
    const result = buildBridgeOutputsView(
      [],
      makeDeps({
        platform: "darwin",
        decklinkModule: decklinkModule(() => ({ kind: "display", state: "missing_runtime" })),
        displayModule: displayModule(() => ({ kind: "decklink", helperMissing: true })),
      }),
    );

    expect(result.diagnostics).toEqual({
      platform: "darwin",
      decklink: { state: "no_devices" },
      display: { state: "no_devices" },
    });
  });
});
