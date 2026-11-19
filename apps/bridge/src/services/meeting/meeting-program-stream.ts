import type { PgmWebrtcCloseT, PgmWebrtcOfferT } from "../pgm/pgm-command-schemas.js";
import { parsePgmEnv } from "../pgm/pgm-env.js";
import { isDeadViewerState } from "../pgm/pgm-helper-manager.js";
import { PgmSessionManager } from "../pgm/pgm-session-manager.js";
import { MeetingHelperRequestError, type MeetingHelperClient } from "./meeting-helper-client.js";
import { meetingHelperManager } from "./meeting-helper-manager.js";

/** Stable codes the web app maps to viewer states (shared with the PGM family where the meaning is the same). */
export type MeetingProgramStreamErrorCodeT =
  | "pgm_disabled"
  | "pgm_viewer_limit"
  | "pgm_session_not_found"
  | "pgm_sdp_invalid"
  | "meeting_engine_not_running"
  | "program_stream_unavailable"
  | "helper_not_reachable";

export class MeetingProgramStreamError extends Error {
  constructor(
    readonly code: MeetingProgramStreamErrorCodeT,
    message: string,
  ) {
    super(message);
    this.name = "MeetingProgramStreamError";
  }
}

export type MeetingProgramStreamDepsT = {
  env: NodeJS.ProcessEnv;
  client: () => MeetingHelperClient | null;
  engineRunning: () => boolean;
  now?: () => number;
};

const defaultDeps: MeetingProgramStreamDepsT = {
  env: process.env,
  client: () => meetingHelperManager.getClient(),
  engineRunning: () => meetingHelperManager.isRunning(),
};

/** How often the bridge-side session map is checked against the helper's live viewers while sessions exist. */
const SESSION_RECONCILE_MS = 10_000;

/**
 * Viewer sessions of the meeting program stream: the composited camera
 * picture the meeting helper encodes and sends over WebRTC. Mirrors the PGM
 * helper manager's session handling (cap per bridge, sessions bound to the
 * viewer who opened them, reconcile against the helper so browsers that
 * vanished without `meeting_program_close` free their slot). The helper is
 * owned by the meeting helper manager; this service only talks to its RPC.
 */
export class MeetingProgramStream {
  private readonly sessions: PgmSessionManager;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MeetingProgramStreamDepsT = defaultDeps) {
    this.sessions = new PgmSessionManager(parsePgmEnv(deps.env).maxViewers, deps.now);
  }

  private requireClient(): MeetingHelperClient {
    if (!parsePgmEnv(this.deps.env).enabled) {
      throw new MeetingProgramStreamError("pgm_disabled", "Live program preview is disabled on this bridge.");
    }
    const client = this.deps.client();
    if (!client || !this.deps.engineRunning()) {
      throw new MeetingProgramStreamError("meeting_engine_not_running", "The meeting engine is not running on this bridge.");
    }
    return client;
  }

  private rethrow(error: unknown): never {
    if (error instanceof MeetingHelperRequestError) {
      const code = error.code;
      if (code === "program_stream_unavailable" || code === "pgm_sdp_invalid" || code === "helper_not_reachable") {
        throw new MeetingProgramStreamError(code, error.message);
      }
      throw new MeetingProgramStreamError("program_stream_unavailable", error.message);
    }
    throw error;
  }

  async offer(payload: PgmWebrtcOfferT): Promise<{ sdp: string; max_viewers: number; active_viewers: number }> {
    const env = parsePgmEnv(this.deps.env);
    const client = this.requireClient();
    if (!this.sessions.reserve(payload.session_id, payload.viewer_user_id, payload.label ?? null)) {
      await this.reconcileSessions();
      if (!this.sessions.reserve(payload.session_id, payload.viewer_user_id, payload.label ?? null)) {
        throw new MeetingProgramStreamError("pgm_viewer_limit", `Viewer limit reached (${env.maxViewers}).`);
      }
    }
    try {
      const { sdp } = await client.programViewerOffer({
        sessionId: payload.session_id,
        sdp: payload.sdp,
        profile: "auto",
        iceServers: payload.ice_servers,
      });
      this.startReconcile();
      return { sdp, max_viewers: env.maxViewers, active_viewers: this.sessions.count() };
    } catch (error: unknown) {
      this.sessions.release(payload.session_id);
      this.rethrow(error);
    }
  }

  async close(payload: PgmWebrtcCloseT): Promise<void> {
    if (!this.sessions.owned(payload.session_id, payload.viewer_user_id)) {
      throw new MeetingProgramStreamError("pgm_session_not_found", "No program stream session with this id for this viewer.");
    }
    this.sessions.release(payload.session_id);
    const client = this.deps.client();
    if (client && this.deps.engineRunning()) {
      await client.programViewerClose(payload.session_id).catch(() => undefined);
    }
    if (this.sessions.count() === 0) {
      this.stopReconcile();
    }
  }

  getSessions(): { sessions: Array<{ session_id: string; viewer_user_id: string; label: string | null; created_at: number }>; max_viewers: number; active_viewers: number } {
    return {
      sessions: this.sessions.list().map((s) => ({ session_id: s.sessionId, viewer_user_id: s.viewerUserId, label: s.label, created_at: s.createdAt })),
      max_viewers: parsePgmEnv(this.deps.env).maxViewers,
      active_viewers: this.sessions.count(),
    };
  }

  /** Helper status plus the bridge-side view: enabled gate, engine running, sessions. */
  async status(): Promise<Record<string, unknown>> {
    const env = parsePgmEnv(this.deps.env);
    const client = this.deps.client();
    const engineRunning = Boolean(client) && this.deps.engineRunning();
    let helper: Record<string, unknown> = { supported: false, active: false, viewers: 0 };
    if (env.enabled && client && engineRunning) {
      helper = await client.programStreamStatus().catch(() => ({ supported: false, active: false, viewers: 0 }));
    }
    return { enabled: env.enabled, engine_running: engineRunning, ...helper, bridge_viewers: this.sessions.count(), max_viewers: env.maxViewers };
  }

  /** Drops sessions whose PeerConnection the helper no longer has (or all of them when the engine stopped). */
  async reconcileSessions(): Promise<string[]> {
    const client = this.deps.client();
    if (!client || !this.deps.engineRunning()) {
      const dropped = this.sessions.list().map((s) => s.sessionId);
      this.sessions.clear();
      this.stopReconcile();
      return dropped;
    }
    let live: Set<string>;
    try {
      const result = await client.programSessionsList();
      live = new Set(result.sessions.filter((s) => !isDeadViewerState(s.state)).map((s) => s.viewer_id));
    } catch {
      return [];
    }
    const dropped = this.sessions.reconcile(live);
    if (this.sessions.count() === 0) {
      this.stopReconcile();
    }
    return dropped;
  }

  private startReconcile(): void {
    if (this.reconcileTimer) {
      return;
    }
    this.reconcileTimer = setInterval(() => {
      void this.reconcileSessions();
    }, SESSION_RECONCILE_MS);
    this.reconcileTimer.unref?.();
  }

  private stopReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** Test/shutdown hook. */
  dispose(): void {
    this.stopReconcile();
    this.sessions.clear();
  }
}

export const meetingProgramStream = new MeetingProgramStream();
