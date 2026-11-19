import { randomUUID } from "node:crypto";
import type { CallEndReasonT } from "./intelligence-types.js";

/** Sustained consumer presence required before a call counts as started. */
const DEFAULT_RISING_MS = 5000;
/** Sustained consumer absence required before a call counts as ended. */
const DEFAULT_FALLING_MS = 15_000;

export type CallDetectorEventT =
  | { type: "call_started"; callId: string; at: number }
  | { type: "call_ended"; callId: string; at: number; reason: CallEndReasonT };

export type CallDetectorSnapshotT = {
  active: boolean;
  callId: string | null;
};

type CallDetectorOptionsT = {
  risingMs?: number;
  fallingMs?: number;
  generateCallId?: () => string;
};

type CallDetectorStateT = "idle" | "arming" | "active" | "cooling";

/**
 * Pure hysteresis state machine over the VCam consumer count
 * (`engine.vcam_clients`): a sustained count > 0 means a meeting client is
 * pulling frames from the Broadify camera, which is the Stufe-1 definition of
 * "a call is running". Time is passed in by the caller (the 2 s status poll),
 * so the machine owns no timers and tests need no fake clocks. Semantics are
 * documented in docs/integration/conversation-intelligence-contract.md §2.
 */
export class CallDetector {
  private readonly risingMs: number;
  private readonly fallingMs: number;
  private readonly generateCallId: () => string;

  private state: CallDetectorStateT = "idle";
  private callId: string | null = null;
  private armingSince = 0;
  private coolingSince = 0;

  constructor(options: CallDetectorOptionsT = {}) {
    this.risingMs = options.risingMs ?? DEFAULT_RISING_MS;
    this.fallingMs = options.fallingMs ?? DEFAULT_FALLING_MS;
    this.generateCallId = options.generateCallId ?? randomUUID;
  }

  /**
   * Feed one consumer-count observation. Returns the transition events this
   * observation caused (usually none).
   */
  observeClientCount(count: number, at: number): CallDetectorEventT[] {
    const present = count > 0;
    switch (this.state) {
      case "idle":
        if (present) {
          this.state = "arming";
          this.armingSince = at;
        }
        return [];
      case "arming":
        if (!present) {
          this.state = "idle";
          return [];
        }
        if (at - this.armingSince >= this.risingMs) {
          this.state = "active";
          this.callId = this.generateCallId();
          return [{ type: "call_started", callId: this.callId, at }];
        }
        return [];
      case "active":
        if (!present) {
          this.state = "cooling";
          this.coolingSince = at;
        }
        return [];
      case "cooling":
        if (present) {
          // Short flap (reconnect, camera toggle): same call continues.
          this.state = "active";
          return [];
        }
        if (at - this.coolingSince >= this.fallingMs) {
          return this.endCall(at, "clients_gone");
        }
        return [];
    }
  }

  /**
   * Hard stop (engine/helper went away): an active or cooling call ends now,
   * without the falling hysteresis.
   */
  reset(at: number): CallDetectorEventT[] {
    if (this.state === "active" || this.state === "cooling") {
      return this.endCall(at, "engine_stopped");
    }
    this.state = "idle";
    return [];
  }

  snapshot(): CallDetectorSnapshotT {
    const active = this.state === "active" || this.state === "cooling";
    return { active, callId: active ? this.callId : null };
  }

  private endCall(at: number, reason: CallEndReasonT): CallDetectorEventT[] {
    const callId = this.callId;
    this.state = "idle";
    this.callId = null;
    if (!callId) {
      return [];
    }
    return [{ type: "call_ended", callId, at, reason }];
  }
}
