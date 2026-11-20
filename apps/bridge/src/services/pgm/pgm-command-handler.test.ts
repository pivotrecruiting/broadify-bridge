import type { PgmRecordingT } from "@broadify/protocol";

import { PgmError } from "./pgm-errors.js";
import { getLiveProgramCapabilities, handlePgmCommand, isPgmCommand, type PgmCommandDepsT } from "./pgm-command-handler.js";

const OFFER = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=recvonly"].join("\r\n");
const offerPayload = { session_id: "6f1d2c1e-9c2a-4a8e-9a0e-1b2c3d4e5f60", sdp: OFFER, viewer_user_id: "0b5a7f6e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ice_servers: [] };

/** What the helper reports once its own archive encoder runs (H.264 High, 0.35 bit/px). */
const ACTIVE_RECORDING = (filePath: string): PgmRecordingT => ({
  active: true,
  file_path: filePath,
  started_at_ms: 1,
  bytes: 0,
  error: null,
  profile: "high",
  bitrate_kbps: 21773,
  width: 1920,
  height: 1080,
  fps_num: 30,
  fps_den: 1,
  frames: 0,
});

function fakeManager() {
  const status = { enabled: true, state: "idle" as const, input: null, signal: null, encoder: null, audio: true, viewers: 0, last_error: null };
  return {
    calls: [] as string[],
    getStatus: () => status,
    getSessions: () => ({ sessions: [], max_viewers: 4, active_viewers: 0 }),
    listInputs: async () => ({ inputs: [], camera_permission: "authorized" }),
    selectSource: async (inputId: string, profile: string) => {
      if (inputId === "uvc:missing") throw new PgmError("input_not_found", "nope");
      return { ...status, state: "running" as const, input: { id: inputId, kind: "uvc" as const, display_name: profile, device_id: "", stable_key: "k", available: true, in_use: false } };
    },
    clearSource: async () => status,
    offer: async () => ({ sdp: "v=0\r\nanswer", max_viewers: 4, active_viewers: 1 }),
    close: async () => undefined,
    snapshot: async (quality: number) => ({ jpeg_base64: "abc", width: 2, height: 2, captured_at_ms: 1, quality }),
    recordingStart: async (filePath: string) => ({ ...status, recording: ACTIVE_RECORDING(filePath) }),
    recordingStop: async () => ({ ...status, recording: { active: false, file_path: null, started_at_ms: null, bytes: 0, error: null } }),
  };
}

const deps = (enabled: boolean, platform: NodeJS.Platform = "darwin"): PgmCommandDepsT & { m: ReturnType<typeof fakeManager> } => {
  const m = fakeManager();
  return { env: enabled ? {} : { BRIDGE_PGM_PREVIEW: "0" }, platform, manager: () => m, m, pickPath: async (name: string) => `/tmp/${name}`, defaultPath: () => "/tmp/default.mp4" };
};

describe("pgm command handler", () => {
  it("owns the pgm_ namespace", () => {
    expect(isPgmCommand("pgm_get_status")).toBe(true);
    expect(isPgmCommand("meeting_get_state")).toBe(false);
  });

  it("advertises the capability from the env gate and platform", () => {
    expect(getLiveProgramCapabilities({ env: {}, platform: "darwin" })).toEqual({ supported: true, enabled: true, audio: true, max_viewers: 4, decklink_input: false, meeting_preview: true, recording: true, recording_profile: "high" });
    // The kill switch keeps `supported` (this is not an old bridge) but reports the feature as disabled.
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_PREVIEW: "0" }, platform: "darwin" })).toMatchObject({ supported: true, enabled: false });
    expect(getLiveProgramCapabilities({ env: {}, platform: "win32" })).toMatchObject({ supported: false, meeting_preview: false });
    // The recording profile is only advertised where the helper (and its High-profile encoder) exists.
    expect(getLiveProgramCapabilities({ env: {}, platform: "win32" })).not.toHaveProperty("recording_profile");
    // A default Windows bridge: the block it advertised before, plus the explicit recording flag.
    expect(getLiveProgramCapabilities({ env: {}, platform: "win32" })).toEqual({ supported: false, enabled: true, audio: false, max_viewers: 4, decklink_input: false, meeting_preview: false, recording: false });
    // The Windows switch changes nothing on macOS.
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_WINDOWS: "1" }, platform: "darwin" })).toEqual(getLiveProgramCapabilities({ env: {}, platform: "darwin" }));
  });

  it("opens preview, audio and the meeting program on Windows only with BRIDGE_PGM_WINDOWS, never the recording", () => {
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_WINDOWS: "1" }, platform: "win32" })).toEqual({ supported: true, enabled: true, audio: true, max_viewers: 4, decklink_input: false, meeting_preview: true, recording: false });
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_WINDOWS: "0" }, platform: "win32" })).toMatchObject({ supported: false, meeting_preview: false, recording: false });
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_WINDOWS: "1", BRIDGE_PGM_PREVIEW: "0" }, platform: "win32" })).toMatchObject({ supported: true, enabled: false, recording: false });
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_WINDOWS: "1" }, platform: "linux" })).toMatchObject({ supported: false, meeting_preview: false, recording: false });
  });

  it("answers status and sessions even while disabled", async () => {
    const d = deps(false);
    expect(await handlePgmCommand("pgm_get_status", {}, d)).toMatchObject({ success: true, data: { enabled: false, state: "idle" } });
    expect(await handlePgmCommand("pgm_session_list", undefined, d)).toMatchObject({ success: true, data: { active_viewers: 0 } });
  });

  it("refuses side effects with pgm_disabled while the gate is off and on unsupported platforms", async () => {
    const off = deps(false);
    for (const [command, payload] of [["pgm_inputs_list", {}], ["pgm_source_select", { input_id: "uvc:1" }], ["pgm_source_clear", {}], ["pgm_webrtc_offer", offerPayload]] as const) {
      expect(await handlePgmCommand(command, payload, off)).toMatchObject({ success: false, errorCode: "pgm_disabled" });
    }
    expect(await handlePgmCommand("pgm_inputs_list", {}, deps(true, "win32"))).toMatchObject({ success: false, errorCode: "pgm_unsupported_bridge" });
  });

  describe("on Windows", () => {
    const closePayload = { session_id: offerPayload.session_id, viewer_user_id: offerPayload.viewer_user_id };
    const sideEffects = [
      ["pgm_inputs_list", {}],
      ["pgm_source_select", { input_id: "uvc:1" }],
      ["pgm_source_clear", {}],
      ["pgm_webrtc_offer", offerPayload],
      ["pgm_webrtc_close", closePayload],
      ["pgm_snapshot", {}],
      ["pgm_recording_pick_path", {}],
      ["pgm_recording_start", {}],
      ["pgm_recording_stop", {}],
    ] as const;
    const winDeps = (env: NodeJS.ProcessEnv) => {
      const m = fakeManager();
      return { env, platform: "win32" as const, m, manager: jest.fn(() => m), pickPath: jest.fn(async (name: string) => `C:\\Users\\me\\Videos\\${name}`), defaultPath: () => "C:\\Users\\me\\Videos\\default.mp4" };
    };

    it("keeps every side effect closed without BRIDGE_PGM_WINDOWS, as before", async () => {
      const d = winDeps({});
      for (const [command, payload] of sideEffects) {
        expect(await handlePgmCommand(command, payload, d)).toMatchObject({ success: false, errorCode: "pgm_unsupported_bridge", error: "Windows preview not enabled on this bridge." });
      }
      expect(d.manager).not.toHaveBeenCalled();
      expect(d.pickPath).not.toHaveBeenCalled();
      // Status and sessions answer on every platform, as before.
      expect(await handlePgmCommand("pgm_get_status", {}, d)).toMatchObject({ success: true, data: { enabled: true, state: "idle" } });
      expect(await handlePgmCommand("pgm_session_list", {}, d)).toMatchObject({ success: true, data: { active_viewers: 0 } });
    });

    it("routes the preview to the helper with BRIDGE_PGM_WINDOWS=1 and answers recording_unsupported itself", async () => {
      const d = winDeps({ BRIDGE_PGM_WINDOWS: "1" });
      const recordingStart = jest.spyOn(d.m, "recordingStart");
      const recordingStop = jest.spyOn(d.m, "recordingStop");
      expect(await handlePgmCommand("pgm_inputs_list", {}, d)).toMatchObject({ success: true, data: { camera_permission: "authorized" } });
      expect(await handlePgmCommand("pgm_source_select", { input_id: "uvc:a" }, d)).toMatchObject({ success: true, data: { state: "running" } });
      expect(await handlePgmCommand("pgm_webrtc_offer", offerPayload, d)).toMatchObject({ success: true, data: { sdp: "v=0\r\nanswer", stream: { codec: "h264" } } });
      expect(await handlePgmCommand("pgm_snapshot", {}, d)).toMatchObject({ success: true, data: { jpeg_base64: "abc" } });
      expect(await handlePgmCommand("pgm_webrtc_close", closePayload, d)).toMatchObject({ success: true });
      for (const command of ["pgm_recording_pick_path", "pgm_recording_start", "pgm_recording_stop"] as const) {
        expect(await handlePgmCommand(command, {}, d)).toMatchObject({ success: false, errorCode: "recording_unsupported", error: "Recording the program is not supported on this platform yet." });
      }
      // No save panel on the bridge machine and no helper round trip for a recording that cannot run.
      expect(d.pickPath).not.toHaveBeenCalled();
      expect(recordingStart).not.toHaveBeenCalled();
      expect(recordingStop).not.toHaveBeenCalled();
    });

    it("lets the kill switch win over BRIDGE_PGM_WINDOWS", async () => {
      const d = winDeps({ BRIDGE_PGM_WINDOWS: "1", BRIDGE_PGM_PREVIEW: "0" });
      for (const [command, payload] of sideEffects) {
        expect(await handlePgmCommand(command, payload, d)).toMatchObject({ success: false, errorCode: "pgm_disabled" });
      }
      expect(d.manager).not.toHaveBeenCalled();
    });
  });

  it("validates payloads before anything else", async () => {
    const d = deps(true);
    expect(await handlePgmCommand("pgm_webrtc_offer", { ...offerPayload, sdp: "garbage" }, d)).toMatchObject({ success: false, errorCode: "pgm_sdp_invalid" });
    expect(await handlePgmCommand("pgm_get_status", { extra: true }, d)).toMatchObject({ success: false });
  });

  it("routes to the manager and maps its errors to stable codes", async () => {
    const d = deps(true);
    expect(await handlePgmCommand("pgm_source_select", { input_id: "uvc:a", profile: "remote" }, d)).toMatchObject({ success: true, data: { state: "running" } });
    expect(await handlePgmCommand("pgm_source_select", { input_id: "uvc:missing" }, d)).toMatchObject({ success: false, errorCode: "input_not_found" });
    const answer = await handlePgmCommand("pgm_webrtc_offer", offerPayload, d);
    expect(answer).toMatchObject({ success: true, data: { session_id: offerPayload.session_id, sdp: "v=0\r\nanswer", active_viewers: 1, stream: { codec: "h264", audio: true } } });
    expect(await handlePgmCommand("pgm_webrtc_close", { session_id: offerPayload.session_id, viewer_user_id: offerPayload.viewer_user_id }, d)).toMatchObject({ success: true });
    expect(await handlePgmCommand("pgm_unknown", {}, d)).toMatchObject({ success: false, error: "Unknown command: pgm_unknown" });
  });

  it("takes snapshots and records with a chosen or default path", async () => {
    const d = deps(true);
    expect(await handlePgmCommand("pgm_snapshot", { quality: 0.5 }, d)).toMatchObject({ success: true, data: { jpeg_base64: "abc", quality: 0.5 } });
    expect(await handlePgmCommand("pgm_snapshot", { quality: 2 }, d)).toMatchObject({ success: false });
    expect(await handlePgmCommand("pgm_recording_pick_path", { default_name: "x.mp4" }, d)).toMatchObject({ success: true, data: { cancelled: false, file_path: "/tmp/x.mp4" } });
    expect(await handlePgmCommand("pgm_recording_start", {}, d)).toMatchObject({ success: true, data: { recording: { active: true, file_path: "/tmp/default.mp4" } } });
    // The archive encoder's parameters pass through untouched (profile, bitrate, geometry, frame counter).
    expect(await handlePgmCommand("pgm_recording_start", {}, d)).toMatchObject({
      success: true,
      data: { recording: { profile: "high", bitrate_kbps: 21773, width: 1920, height: 1080, fps_num: 30, fps_den: 1, frames: 0 } },
    });
    expect(await handlePgmCommand("pgm_recording_start", { file_path: "/Users/me/rec.mp4" }, d)).toMatchObject({ success: true, data: { recording: { file_path: "/Users/me/rec.mp4" } } });
    expect(await handlePgmCommand("pgm_recording_start", { file_path: "../x.mp4" }, d)).toMatchObject({ success: false });
    expect(await handlePgmCommand("pgm_recording_stop", {}, d)).toMatchObject({ success: true, data: { recording: { active: false } } });
  });
});
