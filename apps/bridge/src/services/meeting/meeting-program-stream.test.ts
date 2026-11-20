import { MeetingProgramStream, MeetingProgramStreamError } from "./meeting-program-stream.js";

jest.mock("./meeting-helper-manager.js", () => ({ meetingHelperManager: { getClient: () => null, isRunning: () => false } }));
jest.mock("../bridge-context.js", () => ({
  getBridgeContext: () => ({ userDataDir: "/tmp/broadify-meeting-program-test", logger: { info() {}, warn() {}, error() {}, debug() {} }, publishBridgeEvent: undefined }),
}));

const offer = (id: string, user = "u1") => ({ session_id: id, viewer_user_id: user, sdp: "v=0", ice_servers: [], label: null }) as never;
const env = { BRIDGE_PGM_PREVIEW: "1", BRIDGE_PGM_MAX_VIEWERS: "2" } as NodeJS.ProcessEnv;
// Explicit: the suite also runs in the Windows release build, where process.platform is win32.
const platform: NodeJS.Platform = "darwin";

function fakeClient(live: () => Array<{ viewer_id: string; state: string }>) {
  return {
    programViewerOffer: jest.fn(async () => ({ sdp: "answer" })),
    programViewerClose: jest.fn(async () => ({})),
    programSessionsList: jest.fn(async () => ({ sessions: live().map((v) => ({ ...v, candidate_type: "host", audio: false, age_ms: 1 })) })),
    programStreamStatus: jest.fn(async () => ({ supported: true, active: true, viewers: live().length })),
  };
}

describe("MeetingProgramStream", () => {
  it("refuses offers while the meeting engine is not running", async () => {
    const stream = new MeetingProgramStream({ env, platform, client: () => null, engineRunning: () => false });
    await expect(stream.offer(offer("a"))).rejects.toMatchObject({ code: "meeting_engine_not_running" });
    stream.dispose();
  });

  it("refuses everything while the preview gate is off", async () => {
    const client = fakeClient(() => []);
    const stream = new MeetingProgramStream({ env: { BRIDGE_PGM_PREVIEW: "0" } as NodeJS.ProcessEnv, platform, client: () => client as never, engineRunning: () => true });
    await expect(stream.offer(offer("a"))).rejects.toBeInstanceOf(MeetingProgramStreamError);
    await expect(stream.status()).resolves.toMatchObject({ enabled: false });
    stream.dispose();
  });

  it("answers offers, enforces the cap after asking the helper which viewers are alive", async () => {
    let live: Array<{ viewer_id: string; state: string }> = [];
    const client = fakeClient(() => live);
    const stream = new MeetingProgramStream({ env, platform, client: () => client as never, engineRunning: () => true });
    await expect(stream.offer(offer("a"))).resolves.toMatchObject({ sdp: "answer", active_viewers: 1 });
    await stream.offer(offer("b"));
    expect(client.programViewerOffer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a", profile: "auto" }));
    live = [{ viewer_id: "a", state: "connected" }, { viewer_id: "b", state: "connected" }];
    await expect(stream.offer(offer("c"))).rejects.toMatchObject({ code: "pgm_viewer_limit" });
    live = [{ viewer_id: "a", state: "connected" }, { viewer_id: "b", state: "closed" }];
    await expect(stream.offer(offer("c"))).resolves.toMatchObject({ active_viewers: 2 });
    stream.dispose();
  });

  it("binds close to the viewer who opened the session", async () => {
    const client = fakeClient(() => []);
    const stream = new MeetingProgramStream({ env, platform, client: () => client as never, engineRunning: () => true });
    await stream.offer(offer("a", "owner"));
    await expect(stream.close({ session_id: "a", viewer_user_id: "intruder" })).rejects.toMatchObject({ code: "pgm_session_not_found" });
    await expect(stream.close({ session_id: "a", viewer_user_id: "owner" })).resolves.toBeUndefined();
    expect(client.programViewerClose).toHaveBeenCalledWith("a");
    expect(stream.getSessions().active_viewers).toBe(0);
    stream.dispose();
  });

  it("drops every session once the engine stopped", async () => {
    let running = true;
    const client = fakeClient(() => [{ viewer_id: "a", state: "connected" }]);
    const stream = new MeetingProgramStream({ env, platform, client: () => client as never, engineRunning: () => running });
    await stream.offer(offer("a"));
    running = false;
    await expect(stream.reconcileSessions()).resolves.toEqual(["a"]);
    expect(stream.getSessions().active_viewers).toBe(0);
    stream.dispose();
  });
});

describe("MeetingProgramStream on Windows", () => {
  /** What the meeting helper's stub (program_stream_stub.cpp) reports. */
  const STUB_STATUS = { supported: false, active: false, viewers: 0, encoder: null, encoded_frames: 0, dropped_frames: 0 };

  it("answers like the helper stub without BRIDGE_PGM_WINDOWS and does not ask the helper", async () => {
    const client = fakeClient(() => []);
    const stream = new MeetingProgramStream({ env, platform: "win32", client: () => client as never, engineRunning: () => true });
    await expect(stream.offer(offer("a"))).rejects.toMatchObject({ code: "program_stream_unavailable", message: "The program stream is not available on this platform yet." });
    expect(client.programViewerOffer).not.toHaveBeenCalled();
    expect(stream.getSessions().active_viewers).toBe(0);
    // The earlier refusals keep their precedence.
    const stopped = new MeetingProgramStream({ env, platform: "win32", client: () => null, engineRunning: () => false });
    await expect(stopped.offer(offer("b"))).rejects.toMatchObject({ code: "meeting_engine_not_running" });
    const off = new MeetingProgramStream({ env: { BRIDGE_PGM_PREVIEW: "0" } as NodeJS.ProcessEnv, platform: "win32", client: () => client as never, engineRunning: () => true });
    await expect(off.offer(offer("c"))).rejects.toMatchObject({ code: "pgm_disabled" });
    for (const s of [stream, stopped, off]) s.dispose();
  });

  it("keeps the status of a default Windows bridge and says unsupported even if the helper could stream", async () => {
    const stubClient = { ...fakeClient(() => []), programStreamStatus: jest.fn(async () => STUB_STATUS) };
    const stub = new MeetingProgramStream({ env, platform: "win32", client: () => stubClient as never, engineRunning: () => true });
    await expect(stub.status()).resolves.toEqual({ enabled: true, engine_running: true, ...STUB_STATUS, bridge_viewers: 0, max_viewers: 2 });
    // A helper built with BROADIFY_PGM_WINDOWS=1 reports supported: true; without the run-time switch the bridge does not offer it.
    const capable = new MeetingProgramStream({ env, platform: "win32", client: () => fakeClient(() => []) as never, engineRunning: () => true });
    await expect(capable.status()).resolves.toMatchObject({ supported: false });
    for (const s of [stub, capable]) s.dispose();
  });

  it("streams with BRIDGE_PGM_WINDOWS=1", async () => {
    const client = fakeClient(() => []);
    const stream = new MeetingProgramStream({ env: { ...env, BRIDGE_PGM_WINDOWS: "1" }, platform: "win32", client: () => client as never, engineRunning: () => true });
    await expect(stream.offer(offer("a"))).resolves.toMatchObject({ sdp: "answer", active_viewers: 1 });
    expect(client.programViewerOffer).toHaveBeenCalledTimes(1);
    await expect(stream.status()).resolves.toMatchObject({ supported: true, bridge_viewers: 1 });
    stream.dispose();
  });
});
