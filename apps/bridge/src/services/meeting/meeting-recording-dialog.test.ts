import { pickRecordingSavePath } from "./meeting-recording-dialog.js";

jest.mock("node:os", () => ({
  homedir: () => "/home/test-user",
  platform: () => "win32",
}));

describe("pickRecordingSavePath", () => {
  it("falls back to the default videos path on Windows instead of cancelling", async () => {
    const result = await pickRecordingSavePath("broadify-20260727-1200.mp4");
    expect(result).not.toBeNull();
    expect(result).toMatch(/Videos/);
    expect(result).toMatch(/\.mp4$/);
    expect(result).toContain("Broadify-Meeting-");
  });

  it("gives the fallback path the extension of the requested container", async () => {
    const result = await pickRecordingSavePath("take.mp4", "de", "mov");
    expect(result).toMatch(/Videos[\\/]Broadify[\\/]Broadify-Meeting-.*\.mov$/);
  });
});
