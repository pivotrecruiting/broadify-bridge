import { MeetingProgramStream, MeetingProgramStreamError } from "./meeting-program-stream.js";

jest.mock("./meeting-helper-manager.js", () => ({ meetingHelperManager: { getClient: () => null, isRunning: () => false } }));
jest.mock("../bridge-context.js", () => ({
  getBridgeContext: () => ({ userDataDir: "/tmp/broadify-meeting-program-test", logger: { info() {}, warn() {}, error() {}, debug() {} }, publishBridgeEvent: undefined }),
}));

const offer = (id: string, user = "u1") => ({ session_id: id, viewer_user_id: user, sdp: "v=0", ice_servers: [], label: null }) as never;
const env = { BRIDGE_PGM_PREVIEW: "1", BRIDGE_PGM_MAX_VIEWERS: "2" } as NodeJS.ProcessEnv;

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
    const stream = new MeetingProgramStream({ env, client: () => null, engineRunning: () => false });
    await expect(stream.offer(offer("a"))).rejects.toMatchObject({ code: "meeting_engine_not_running" });
    stream.dispose();
  });

  it("refuses everything while the preview gate is off", async () => {
    const client = fakeClient(() => []);
    const stream = new MeetingProgramStream({ env: {} as NodeJS.ProcessEnv, client: () => client as never, engineRunning: () => true });
    await expect(stream.offer(offer("a"))).rejects.toBeInstanceOf(MeetingProgramStreamError);
    await expect(stream.status()).resolves.toMatchObject({ enabled: false });
    stream.dispose();
  });

  it("answers offers, enforces the cap after asking the helper which viewers are alive", async () => {
    let live: Array<{ viewer_id: string; state: string }> = [];
    const client = fakeClient(() => live);
    const stream = new MeetingProgramStream({ env, client: () => client as never, engineRunning: () => true });
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
    const stream = new MeetingProgramStream({ env, client: () => client as never, engineRunning: () => true });
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
    const stream = new MeetingProgramStream({ env, client: () => client as never, engineRunning: () => running });
    await stream.offer(offer("a"));
    running = false;
    await expect(stream.reconcileSessions()).resolves.toEqual(["a"]);
    expect(stream.getSessions().active_viewers).toBe(0);
    stream.dispose();
  });
});
