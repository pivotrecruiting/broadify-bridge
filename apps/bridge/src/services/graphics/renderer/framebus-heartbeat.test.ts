import {
  FRAMEBUS_HEARTBEAT_INTERVAL_MS,
  shouldRepublishHeartbeatFrame,
} from "./framebus-heartbeat.js";

describe("framebus-heartbeat", () => {
  it("republishes when the last write is at least one interval old", () => {
    expect(
      shouldRepublishHeartbeatFrame(
        true,
        true,
        10_000,
        10_000 - FRAMEBUS_HEARTBEAT_INTERVAL_MS,
      ),
    ).toBe(true);
    expect(shouldRepublishHeartbeatFrame(true, true, 12_500, 10_000)).toBe(true);
  });

  it("stays quiet while recent paints keep the seq advancing", () => {
    expect(
      shouldRepublishHeartbeatFrame(
        true,
        true,
        10_000,
        10_000 - FRAMEBUS_HEARTBEAT_INTERVAL_MS + 1,
      ),
    ).toBe(false);
  });

  it("does nothing without a writer", () => {
    expect(shouldRepublishHeartbeatFrame(false, true, 10_000, 0)).toBe(false);
  });

  it("does nothing before the first frame was written", () => {
    expect(shouldRepublishHeartbeatFrame(true, false, 10_000, 0)).toBe(false);
  });
});
