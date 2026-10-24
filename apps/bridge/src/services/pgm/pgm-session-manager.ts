/**
 * Viewer sessions as the bridge sees them: session id ↔ viewer, creation
 * time, cap. The native helper owns the PeerConnections; this map binds a
 * session to the user who opened it so `pgm_webrtc_close` cannot close
 * someone else's view, and enforces the viewer cap before the helper is asked.
 */
export type PgmSessionT = {
  sessionId: string;
  viewerUserId: string;
  label: string | null;
  createdAt: number;
};

export class PgmSessionManager {
  private readonly sessions = new Map<string, PgmSessionT>();

  constructor(private readonly maxViewers: number, private readonly now: () => number = Date.now) {}

  count(): number {
    return this.sessions.size;
  }

  list(): PgmSessionT[] {
    return [...this.sessions.values()];
  }

  /** Reserves a slot; returns false when the cap is reached (an existing session id is replaced, not counted twice). */
  reserve(sessionId: string, viewerUserId: string, label: string | null): boolean {
    if (!this.sessions.has(sessionId) && this.sessions.size >= this.maxViewers) {
      return false;
    }
    this.sessions.set(sessionId, { sessionId, viewerUserId, label, createdAt: this.now() });
    return true;
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Session owned by this viewer, or null (unknown id or someone else's session). */
  owned(sessionId: string, viewerUserId: string): PgmSessionT | null {
    const session = this.sessions.get(sessionId);
    return session && session.viewerUserId === viewerUserId ? session : null;
  }

  /** Drops sessions the helper no longer reports; returns the dropped ids. */
  reconcile(liveSessionIds: Set<string>): string[] {
    const dropped: string[] = [];
    for (const id of this.sessions.keys()) {
      if (!liveSessionIds.has(id)) {
        this.sessions.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  clear(): void {
    this.sessions.clear();
  }
}
