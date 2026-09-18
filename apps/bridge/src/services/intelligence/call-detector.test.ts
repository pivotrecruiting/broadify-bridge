import { CallDetector } from "./call-detector.js";

const RISING_MS = 5000;
const FALLING_MS = 15_000;

function createDetector(): CallDetector {
  let nextId = 0;
  return new CallDetector({
    risingMs: RISING_MS,
    fallingMs: FALLING_MS,
    generateCallId: () => `call-${++nextId}`,
  });
}

describe("CallDetector", () => {
  it("stays idle without consumers", () => {
    const detector = createDetector();
    expect(detector.observeClientCount(0, 0)).toEqual([]);
    expect(detector.observeClientCount(0, 60_000)).toEqual([]);
    expect(detector.snapshot()).toEqual({ active: false, callId: null });
  });

  it("requires the rising hysteresis before starting a call", () => {
    const detector = createDetector();
    expect(detector.observeClientCount(1, 0)).toEqual([]);
    expect(detector.observeClientCount(1, RISING_MS - 1)).toEqual([]);
    expect(detector.snapshot().active).toBe(false);
    expect(detector.observeClientCount(1, RISING_MS)).toEqual([
      { type: "call_started", callId: "call-1", at: RISING_MS },
    ]);
    expect(detector.snapshot()).toEqual({ active: true, callId: "call-1" });
  });

  it("ignores a blip shorter than the rising hysteresis (device preview)", () => {
    const detector = createDetector();
    detector.observeClientCount(1, 0);
    expect(detector.observeClientCount(0, 2000)).toEqual([]);
    // Presence must be sustained from scratch after the drop.
    expect(detector.observeClientCount(1, 3000)).toEqual([]);
    expect(detector.observeClientCount(1, 3000 + RISING_MS - 1)).toEqual([]);
    expect(detector.observeClientCount(1, 3000 + RISING_MS)).toHaveLength(1);
  });

  it("keeps the same call across a short consumer flap", () => {
    const detector = createDetector();
    detector.observeClientCount(1, 0);
    detector.observeClientCount(1, RISING_MS);
    expect(detector.observeClientCount(0, 10_000)).toEqual([]);
    // Client comes back inside the falling window: no events, same call.
    expect(detector.observeClientCount(2, 12_000)).toEqual([]);
    expect(detector.snapshot()).toEqual({ active: true, callId: "call-1" });
  });

  it("ends the call after the falling hysteresis", () => {
    const detector = createDetector();
    detector.observeClientCount(1, 0);
    detector.observeClientCount(1, RISING_MS);
    detector.observeClientCount(0, 10_000);
    expect(detector.observeClientCount(0, 10_000 + FALLING_MS - 1)).toEqual([]);
    expect(detector.observeClientCount(0, 10_000 + FALLING_MS)).toEqual([
      {
        type: "call_ended",
        callId: "call-1",
        at: 10_000 + FALLING_MS,
        reason: "clients_gone",
      },
    ]);
    expect(detector.snapshot()).toEqual({ active: false, callId: null });
  });

  it("starts a fresh call id after a completed call", () => {
    const detector = createDetector();
    detector.observeClientCount(1, 0);
    detector.observeClientCount(1, RISING_MS);
    detector.observeClientCount(0, 10_000);
    detector.observeClientCount(0, 10_000 + FALLING_MS);
    detector.observeClientCount(1, 40_000);
    const events = detector.observeClientCount(1, 40_000 + RISING_MS);
    expect(events).toEqual([
      { type: "call_started", callId: "call-2", at: 40_000 + RISING_MS },
    ]);
  });

  it("ends an active call immediately on reset (engine stopped)", () => {
    const detector = createDetector();
    detector.observeClientCount(1, 0);
    detector.observeClientCount(1, RISING_MS);
    expect(detector.reset(7000)).toEqual([
      {
        type: "call_ended",
        callId: "call-1",
        at: 7000,
        reason: "engine_stopped",
      },
    ]);
    expect(detector.snapshot()).toEqual({ active: false, callId: null });
  });

  it("also closes a cooling call on reset", () => {
    const detector = createDetector();
    detector.observeClientCount(1, 0);
    detector.observeClientCount(1, RISING_MS);
    detector.observeClientCount(0, 10_000);
    expect(detector.reset(11_000)).toEqual([
      {
        type: "call_ended",
        callId: "call-1",
        at: 11_000,
        reason: "engine_stopped",
      },
    ]);
  });

  it("reset while idle or arming produces no events", () => {
    const detector = createDetector();
    expect(detector.reset(0)).toEqual([]);
    detector.observeClientCount(1, 1000);
    expect(detector.reset(2000)).toEqual([]);
    expect(detector.snapshot().active).toBe(false);
  });
});
