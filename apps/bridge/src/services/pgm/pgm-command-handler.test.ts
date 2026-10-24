import { getLiveProgramCapabilities, handlePgmCommand, isPgmCommand } from "./pgm-command-handler.js";

const OFFER = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=recvonly"].join("\r\n");
const offerPayload = { session_id: "6f1d2c1e-9c2a-4a8e-9a0e-1b2c3d4e5f60", sdp: OFFER, viewer_user_id: "0b5a7f6e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ice_servers: [] };
const off = { env: {}, platform: "darwin" as const };
const on = { env: { BRIDGE_PGM_PREVIEW: "1" }, platform: "darwin" as const };

describe("pgm command handler (phase 0)", () => {
  it("owns the pgm_ namespace", () => {
    expect(isPgmCommand("pgm_get_status")).toBe(true);
    expect(isPgmCommand("meeting_get_state")).toBe(false);
  });

  it("advertises the capability from the env gate", () => {
    expect(getLiveProgramCapabilities(off)).toEqual({ supported: false, audio: false, max_viewers: 4, decklink_input: false });
    expect(getLiveProgramCapabilities({ ...on, env: { ...on.env, BRIDGE_PGM_MAX_VIEWERS: "2" } }).max_viewers).toBe(2);
  });

  it("answers status and sessions even while disabled", async () => {
    const status = await handlePgmCommand("pgm_get_status", {}, off);
    expect(status).toMatchObject({ success: true, data: { enabled: false, state: "idle", viewers: 0 } });
    const sessions = await handlePgmCommand("pgm_session_list", undefined, off);
    expect(sessions).toMatchObject({ success: true, data: { sessions: [], active_viewers: 0 } });
  });

  it("refuses side effects with pgm_disabled while the gate is off", async () => {
    for (const [command, payload] of [["pgm_inputs_list", {}], ["pgm_source_select", { input_id: "uvc:1" }], ["pgm_source_clear", {}], ["pgm_webrtc_offer", offerPayload]] as const) {
      expect(await handlePgmCommand(command, payload, off)).toMatchObject({ success: false, errorCode: "pgm_disabled" });
    }
  });

  it("validates payloads before anything else", async () => {
    expect(await handlePgmCommand("pgm_webrtc_offer", { ...offerPayload, sdp: "garbage" }, on)).toMatchObject({ success: false, errorCode: "pgm_sdp_invalid" });
    expect(await handlePgmCommand("pgm_get_status", { extra: true }, on)).toMatchObject({ success: false });
  });

  it("reports not_implemented for the parts that ship with the helper", async () => {
    expect(await handlePgmCommand("pgm_webrtc_offer", offerPayload, on)).toMatchObject({ success: false, errorCode: "pgm_not_implemented" });
    expect(await handlePgmCommand("pgm_webrtc_close", { session_id: offerPayload.session_id, viewer_user_id: offerPayload.viewer_user_id }, on)).toMatchObject({ success: false, errorCode: "pgm_session_not_found" });
    expect(await handlePgmCommand("pgm_unknown", {}, on)).toMatchObject({ success: false, error: "Unknown command: pgm_unknown" });
  });
});
