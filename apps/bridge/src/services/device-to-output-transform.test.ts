import type { DeviceDescriptorT } from "@broadify/protocol";
import { transformDevicesToOutputs } from "./device-to-output-transform.js";

const makeDevice = (
  overrides: Partial<DeviceDescriptorT> = {}
): DeviceDescriptorT =>
  ({
    id: "device-1",
    displayName: "Test Device",
    type: "decklink",
    ports: [],
    status: {
      present: true,
      ready: true,
      inUse: false,
      lastSeen: Date.now(),
    },
    ...overrides,
  }) as DeviceDescriptorT;

describe("device-to-output-transform", () => {
  describe("transformDevicesToOutputs", () => {
    it("returns empty outputs for empty devices", () => {
      expect(transformDevicesToOutputs([])).toEqual({
        output1: [],
        output2: [],
      });
    });

    it("maps decklink device type to decklink output type", () => {
      const devices = [
        makeDevice({
          ports: [
            {
              id: "port-1",
              displayName: "SDI",
              type: "sdi",
              direction: "output",
              role: "video",
              capabilities: { formats: [], modes: [] },
              status: { available: true },
            },
          ],
        }),
      ];
      const result = transformDevicesToOutputs(devices);
      expect(result.output1[0].type).toBe("decklink");
    });

    it("puts key ports in output2", () => {
      const devices = [
        makeDevice({
          ports: [
            {
              id: "fill",
              displayName: "Fill",
              type: "sdi",
              direction: "output",
              role: "fill",
              capabilities: { formats: [], modes: [] },
              status: { available: true },
            },
            {
              id: "key",
              displayName: "Key",
              type: "sdi",
              direction: "output",
              role: "key",
              capabilities: { formats: [], modes: [] },
              status: { available: true },
            },
          ],
        }),
      ];
      const result = transformDevicesToOutputs(devices);
      expect(result.output1).toHaveLength(1);
      expect(result.output2).toHaveLength(1);
      expect(result.output2[0].portRole).toBe("key");
    });

    it("skips input-only ports", () => {
      const devices = [
        makeDevice({
          ports: [
            {
              id: "input",
              displayName: "Input",
              type: "sdi",
              direction: "input",
              role: "video",
              capabilities: { formats: [], modes: [] },
              status: { available: true },
            },
          ],
        }),
      ];
      const result = transformDevicesToOutputs(devices);
      expect(result.output1).toHaveLength(0);
    });

    it("marks unavailable when device inUse", () => {
      const devices = [
        makeDevice({
          status: { present: true, ready: true, inUse: true, lastSeen: Date.now() },
          ports: [
            {
              id: "p1",
              displayName: "Out",
              type: "sdi",
              direction: "output",
              role: "video",
              capabilities: { formats: [], modes: [] },
              status: { available: true },
            },
          ],
        }),
      ];
      const result = transformDevicesToOutputs(devices);
      expect(result.output1[0].available).toBe(false);
    });
  });
});
