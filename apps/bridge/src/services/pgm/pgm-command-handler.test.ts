import { PgmError } from "./pgm-errors.js";
import { getLiveProgramCapabilities, handlePgmCommand, isPgmCommand, type PgmCommandDepsT } from "./pgm-command-handler.js";

const OFFER = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=recvonly"].join("\r\n");
const offerPayload = { session_id: "6f1d2c1e-9c2a-4a8e-9a0e-1b2c3d4e5f60", sdp: OFFER, viewer_user_id: "0b5a7f6e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ice_servers: [] };

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
    recordingStart: async (filePath: string) => ({ ...status, recording: { active: true, file_path: filePath, started_at_ms: 1, bytes: 0, error: null } }),
    recordingStop: async () => ({ ...status, recording: { active: false, file_path: null, started_at_ms: null, bytes: 0, error: null } }),
  };
}

const deps = (enabled: boolean, platform: NodeJS.Platform = "darwin"): PgmCommandDepsT & { m: ReturnType<typeof fakeManager> } => {
  const m = fakeManager();
  return { env: enabled ? { BRIDGE_PGM_PREVIEW: "1" } : {}, platform, manager: () => m, m, pickPath: async (name: string) => `/tmp/${name}`, defaultPath: () => "/tmp/default.mp4" };
};

describe("pgm command handler", () => {
  it("owns the pgm_ namespace", () => {
    expect(isPgmCommand("pgm_get_status")).toBe(true);
    expect(isPgmCommand("meeting_get_state")).toBe(false);
  });

  it("advertises the capability from the env gate and platform", () => {
    expect(getLiveProgramCapabilities({ env: {}, platform: "darwin" })).toEqual({ supported: false, audio: false, max_viewers: 4, decklink_input: false });
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_PREVIEW: "1" }, platform: "darwin" }).supported).toBe(true);
    expect(getLiveProgramCapabilities({ env: { BRIDGE_PGM_PREVIEW: "1" }, platform: "win32" }).supported).toBe(false);
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
    expect(await handlePgmCommand("pgm_recording_start", { file_path: "/Users/me/rec.mp4" }, d)).toMatchObject({ success: true, data: { recording: { file_path: "/Users/me/rec.mp4" } } });
    expect(await handlePgmCommand("pgm_recording_start", { file_path: "../x.mp4" }, d)).toMatchObject({ success: false });
    expect(await handlePgmCommand("pgm_recording_stop", {}, d)).toMatchObject({ success: true, data: { recording: { active: false } } });
  });
});
