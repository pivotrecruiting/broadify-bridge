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
      moduleName === "decklink" ? options.decklinkModule : undefined,
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
  });
});
