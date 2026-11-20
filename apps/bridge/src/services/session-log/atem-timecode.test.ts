import { extrapolateTimecode, framesToTimecode, timecodeToFrames, videoModeFps } from "./atem-timecode.js";

describe("atem-timecode", () => {
  const t = { hour: 1, minute: 2, second: 3, frame: 4, dropFrame: false };

  test("round trip at 25 fps", () => {
    expect(framesToTimecode(timecodeToFrames(t, 25), 25)).toBe("01:02:03:04");
  });

  test("extrapolates by wall clock", () => {
    expect(extrapolateTimecode({ time: t, atMs: 1000 }, 1000, 25)).toBe("01:02:03:04");
    expect(extrapolateTimecode({ time: t, atMs: 1000 }, 3000, 25)).toBe("01:02:05:04");
    expect(extrapolateTimecode({ time: t, atMs: 1000 }, 1000 + 21 * 40, 25)).toBe("01:02:04:00");
    expect(extrapolateTimecode(null, 5000, 25)).toBeNull();
    expect(extrapolateTimecode({ time: t, atMs: 1000 }, 9000, null)).toBe("01:02:03:04");
  });

  test("wraps at midnight and knows the video modes", () => {
    expect(framesToTimecode(24 * 3600 * 25 + 1, 25)).toBe("00:00:00:01");
    expect(videoModeFps(10)).toBe(25);
    expect(videoModeFps(13)).toBe(59.94);
    expect(videoModeFps(99)).toBeNull();
  });
});
