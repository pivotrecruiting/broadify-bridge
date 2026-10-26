import {
  DEFAULT_RECORDINGS_SUBDIR,
  buildDefaultRecordingPath,
  formatRecordingTimestamp,
  resolveDefaultRecordingsDir,
} from "./recording-paths.js";

describe("recording-paths", () => {
  const fixedNow = new Date(2026, 9, 26, 14, 5, 9); // local time: 2026-10-26 14:05:09

  describe("resolveDefaultRecordingsDir", () => {
    it.each([
      ["darwin", "/Users/op", "/Users/op/Movies/Broadify"],
      ["linux", "/home/op", "/home/op/Movies/Broadify"],
    ] as const)("uses ~/Movies/Broadify on %s", (platform, home, expected) => {
      expect(resolveDefaultRecordingsDir(platform, home)).toBe(expected);
    });

    it("uses ~/Videos/Broadify on win32", () => {
      const dir = resolveDefaultRecordingsDir("win32", "C:\\Users\\op");
      expect(dir).toMatch(/Videos[\\/]Broadify$/);
      expect(dir).toContain("C:\\Users\\op");
      expect(dir).not.toMatch(/Movies/);
    });

    it("exposes the shared sub folder name", () => {
      expect(DEFAULT_RECORDINGS_SUBDIR).toBe("Broadify");
    });
  });

  describe("formatRecordingTimestamp", () => {
    it("formats YYYY-MM-DD_HH-mm-ss in local time with zero padding", () => {
      expect(formatRecordingTimestamp(fixedNow)).toBe("2026-10-26_14-05-09");
      expect(formatRecordingTimestamp(new Date(2026, 0, 3, 7, 8, 1))).toBe(
        "2026-01-03_07-08-01",
      );
    });
  });

  describe("buildDefaultRecordingPath", () => {
    it("builds the meeting file name under the shared folder", () => {
      const mkdir = jest.fn();
      const result = buildDefaultRecordingPath("meeting", fixedNow, {
        platform: "darwin",
        home: "/Users/op",
        mkdir,
      });
      expect(result).toBe(
        "/Users/op/Movies/Broadify/Broadify-Meeting-2026-10-26_14-05-09.mp4",
      );
    });

    it("builds the PGM file name under the same folder", () => {
      const result = buildDefaultRecordingPath("pgm", fixedNow, {
        platform: "linux",
        home: "/home/op",
        mkdir: () => undefined,
      });
      expect(result).toBe(
        "/home/op/Movies/Broadify/Broadify-PGM-2026-10-26_14-05-09.mp4",
      );
    });

    it("uses the Windows Videos folder", () => {
      const result = buildDefaultRecordingPath("meeting", fixedNow, {
        platform: "win32",
        home: "C:\\Users\\op",
        mkdir: () => undefined,
      });
      expect(result).toMatch(
        /Videos[\\/]Broadify[\\/]Broadify-Meeting-2026-10-26_14-05-09\.mp4$/,
      );
    });

    it("creates the recordings folder once (best effort)", () => {
      const mkdir = jest.fn();
      buildDefaultRecordingPath("meeting", fixedNow, {
        platform: "darwin",
        home: "/Users/op",
        mkdir,
      });
      expect(mkdir).toHaveBeenCalledTimes(1);
      expect(mkdir).toHaveBeenCalledWith("/Users/op/Movies/Broadify");
    });

    it("swallows mkdir failures and still returns the path", () => {
      const mkdir = jest.fn(() => {
        throw new Error("EACCES");
      });
      const result = buildDefaultRecordingPath("pgm", fixedNow, {
        platform: "darwin",
        home: "/Users/op",
        mkdir,
      });
      expect(result).toBe(
        "/Users/op/Movies/Broadify/Broadify-PGM-2026-10-26_14-05-09.mp4",
      );
    });

    it("yields an absolute .mp4 path without parent traversal (relay guard compatible)", () => {
      const result = buildDefaultRecordingPath("meeting", fixedNow, {
        platform: "darwin",
        home: "/Users/op",
        mkdir: () => undefined,
      });
      expect(result.startsWith("/")).toBe(true);
      expect(result).toMatch(/\.mp4$/);
      expect(result).not.toContain("..");
    });
  });
});
