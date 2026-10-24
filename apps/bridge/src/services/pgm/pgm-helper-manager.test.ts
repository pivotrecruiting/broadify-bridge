import { applyHelperEvent, idlePgmStatus } from "./pgm-helper-manager.js";

jest.mock("../bridge-context.js", () => ({
  getBridgeContext: () => ({ userDataDir: "/tmp/broadify-pgm-test", logger: { info() {}, warn() {}, error() {}, debug() {} }, publishBridgeEvent: undefined }),
}));

describe("applyHelperEvent", () => {
  const base = idlePgmStatus(true);

  it("takes a full status snapshot and keeps the gate flag", () => {
    const line = JSON.stringify({ type: "pgm_status", status: { ...base, enabled: false, state: "running", viewers: 2 } });
    expect(applyHelperEvent(base, line)).toMatchObject({ kind: "pgm_status", status: { enabled: true, state: "running", viewers: 2 } });
  });

  it("merges signal and error events, ignores garbage", () => {
    const signal = { width: 1920, height: 1080, fps_num: 60000, fps_den: 1001, scan: "progressive", pixel_format: "nv12", no_signal: false };
    expect(applyHelperEvent(base, JSON.stringify({ type: "pgm_signal", signal }))).toMatchObject({ kind: "pgm_signal", status: { signal } });
    expect(applyHelperEvent(base, JSON.stringify({ type: "pgm_error", code: "encoder_unavailable", message: "x" }))).toMatchObject({ status: { state: "error", last_error: { code: "encoder_unavailable" } } });
    expect(applyHelperEvent(base, "not json")).toBeNull();
    expect(applyHelperEvent(base, JSON.stringify({ type: "ready" }))).toMatchObject({ kind: "ready", status: base });
  });
});
