import { applyHelperEvent, idlePgmStatus, isDeadViewerState, PgmHelperManager } from "./pgm-helper-manager.js";

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

  it("merges pgm_recording events into status.recording (helper-side start and stop without a status round trip)", () => {
    const started = applyHelperEvent(
      base,
      JSON.stringify({ type: "pgm_recording", active: true, file_path: "/tmp/rec.mp4", profile: "high", bitrate_kbps: 21773, width: 1920, height: 1080, fps_num: 30, fps_den: 1 }),
    );
    expect(started).toMatchObject({
      kind: "pgm_recording",
      status: { recording: { active: true, file_path: "/tmp/rec.mp4", profile: "high", bitrate_kbps: 21773, width: 1920, height: 1080, fps_num: 30, fps_den: 1, error: null } },
    });
    // A clean helper-side stop (clearSource, shutdown) ends the recording in the projection.
    const stopped = applyHelperEvent(started!.status, JSON.stringify({ type: "pgm_recording", active: false, ok: true, error: null }));
    expect(stopped).toMatchObject({ kind: "pgm_recording", status: { recording: { active: false, file_path: null, started_at_ms: null, error: null } } });
    expect(stopped!.status.recording).not.toHaveProperty("profile");
    // A failed stop keeps the error so the UI can show it until the next status snapshot.
    const failed = applyHelperEvent(started!.status, JSON.stringify({ type: "pgm_recording", active: false, ok: false, error: "finishWriting exceeded 15 s" }));
    expect(failed).toMatchObject({ status: { recording: { active: false, error: "finishWriting exceeded 15 s" } } });
    // Malformed recording events leave the projection alone.
    expect(applyHelperEvent(base, JSON.stringify({ type: "pgm_recording", active: "yes" }))).toMatchObject({ kind: "pgm_recording", status: base });
  });
});

describe("viewer session cleanup", () => {
  const offer = (id: string) => ({ session_id: id, viewer_user_id: "u1", sdp: "v=0", ice_servers: [], label: null }) as never;
  const env = { BRIDGE_PGM_PREVIEW: "1", BRIDGE_PGM_MAX_VIEWERS: "2" } as NodeJS.ProcessEnv;

  function runningManager(liveViewers: () => Array<{ viewer_id: string; state: string }>) {
    const client = {
      sessionsList: jest.fn(async () => ({ sessions: liveViewers().map((v) => ({ ...v, candidate_type: "host", audio: false, age_ms: 1 })) })),
      viewerOffer: jest.fn(async () => ({ sdp: "answer" })),
      viewerClose: jest.fn(async () => ({})),
    };
    const manager = new PgmHelperManager({ env, platform: "darwin", userDataDir: () => "/tmp/broadify-pgm-test-sessions", createClient: () => client as never });
    // Pretend the helper is up: the spawn path is covered by the native/integration tests.
    Object.assign(manager as unknown as Record<string, unknown>, { client, state: "running", sourceLoaded: true, source: { version: 1, input: { kind: "uvc", stable_key: "k", display_name: "d" }, profile: "auto" } });
    return { manager, client };
  }

  it("names the states after which the helper drops a viewer", () => {
    expect(isDeadViewerState("closed")).toBe(true);
    expect(isDeadViewerState("failed")).toBe(true);
    expect(isDeadViewerState("connected")).toBe(false);
    expect(isDeadViewerState("disconnected")).toBe(false);
  });

  it("releases the slot when the helper reports the viewer closed", async () => {
    const { manager } = runningManager(() => []);
    await manager.offer(offer("a"));
    await manager.offer(offer("b"));
    expect(manager.getStatus().viewers).toBe(2);
    (manager as unknown as { handleHelperLine: (line: string) => void }).handleHelperLine(JSON.stringify({ type: "pgm_viewer_state", viewer_id: "a", state: "disconnected" }));
    expect(manager.getStatus().viewers).toBe(2);
    (manager as unknown as { handleHelperLine: (line: string) => void }).handleHelperLine(JSON.stringify({ type: "pgm_viewer_state", viewer_id: "a", state: "closed" }));
    expect(manager.getStatus().viewers).toBe(1);
  });

  it("asks the helper which viewers are alive before refusing with the viewer limit", async () => {
    let live: Array<{ viewer_id: string; state: string }> = [];
    const { manager, client } = runningManager(() => live);
    await manager.offer(offer("a"));
    await manager.offer(offer("b"));
    live = [{ viewer_id: "a", state: "connected" }, { viewer_id: "b", state: "connected" }];
    await expect(manager.offer(offer("c"))).rejects.toMatchObject({ code: "pgm_viewer_limit" });
    expect(client.sessionsList).toHaveBeenCalledTimes(1);
    // Browser "b" reloaded without pgm_webrtc_close: the helper reaped it.
    live = [{ viewer_id: "a", state: "connected" }, { viewer_id: "b", state: "closed" }];
    await expect(manager.offer(offer("c"))).resolves.toMatchObject({ sdp: "answer", active_viewers: 2 });
    expect(manager.getStatus().viewers).toBe(2);
  });

  it("reconciles periodically against the helper's session list", async () => {
    const { manager } = runningManager(() => [{ viewer_id: "b", state: "connecting" }]);
    await manager.offer(offer("a"));
    await manager.offer(offer("b"));
    await expect(manager.reconcileSessions()).resolves.toEqual(["a"]);
    expect(manager.getStatus().viewers).toBe(1);
  });
});

describe("program source persistence", () => {
  it("resolves the store lazily (singleton exists before the bridge context) and reloads the source", async () => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pgm-source-"));
    let contextReady = false;
    const deps = {
      env: { BRIDGE_PGM_PREVIEW: "1" } as NodeJS.ProcessEnv,
      platform: "darwin" as NodeJS.Platform,
      userDataDir: () => {
        if (!contextReady) {
          throw new Error("Bridge context not initialized");
        }
        return dir;
      },
      createClient: () => ({}) as never,
    };
    const manager = new PgmHelperManager(deps);
    contextReady = true;
    Object.assign(manager as unknown as Record<string, unknown>, { client: { sourceClear: jest.fn(async () => idlePgmStatus(true)), shutdown: jest.fn(async () => undefined) }, state: "running" });
    await manager.clearSource();
    expect(existsSync(join(dir, "pgm", "pgm-source.json"))).toBe(true);
    const reloaded = new PgmHelperManager(deps);
    expect(reloaded.getSource()).toEqual({ version: 1, input: null, profile: "auto" });
  });
});
