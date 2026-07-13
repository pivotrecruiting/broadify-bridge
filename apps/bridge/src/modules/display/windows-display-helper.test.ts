import { parseNativeWindowsDisplayList } from "./windows-display-helper.js";

const createPayload = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "display_list",
    version: 1,
    displays: [
      {
        device_name: "\\\\.\\DISPLAY2",
        monitor_device_path: "\\\\?\\DISPLAY#BMD0001#ATEM",
        friendly_name: "Blackmagic ATEM",
        adapter_luid: "00000000:00000042",
        target_id: 2,
        output_technology: 5,
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080,
        primary: false,
        modes: [
          {
            width: 1920,
            height: 1080,
            refresh_numerator: 60_000,
            refresh_denominator: 1_001,
            interlaced: false,
            preferred: true,
          },
        ],
        ...overrides,
      },
    ],
  });

describe("windows-display-helper", () => {
  it("maps native HDMI output and preserves fractional refresh rate", () => {
    const displays = parseNativeWindowsDisplayList(createPayload());

    expect(displays).toEqual([
      expect.objectContaining({
        name: "Blackmagic ATEM",
        connectionType: "hdmi",
        nativeSelector: "\\\\.\\DISPLAY2",
        resolution: { width: 1920, height: 1080 },
        modes: [
          expect.objectContaining({
            fps: 60_000 / 1_001,
            fieldDominance: "progressive",
            preferred: true,
          }),
        ],
      }),
    ]);
  });

  it("keeps the monitor ID stable when adapter and target IDs change", () => {
    const first = parseNativeWindowsDisplayList(createPayload())[0]?.stableId;
    const second = parseNativeWindowsDisplayList(
      createPayload({
        adapter_luid: "00000001:00000099",
        target_id: 7,
      }),
    )[0]?.stableId;

    expect(first).toMatch(/^win-[0-9a-f]{16}$/);
    expect(second).toBe(first);
  });

  it("filters internal display technology", () => {
    const displays = parseNativeWindowsDisplayList(
      createPayload({ output_technology: -2_147_483_648 }),
    );

    expect(displays).toEqual([]);
  });

  it("rejects helper payloads with a non-display selector", () => {
    expect(() =>
      parseNativeWindowsDisplayList(
        createPayload({ device_name: "C:\\Windows\\System32" }),
      ),
    ).toThrow();
  });

  it("rejects unknown fields instead of widening the helper contract", () => {
    expect(() =>
      parseNativeWindowsDisplayList(createPayload({ unexpected: true })),
    ).toThrow();
  });
});
