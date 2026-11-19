import { PgmSessionManager } from "./pgm-session-manager.js";

describe("PgmSessionManager", () => {
  it("enforces the viewer cap and binds sessions to viewers", () => {
    const m = new PgmSessionManager(2, () => 1000);
    expect(m.reserve("s1", "u1", null)).toBe(true);
    expect(m.reserve("s2", "u2", "Regie")).toBe(true);
    expect(m.reserve("s3", "u3", null)).toBe(false);
    expect(m.reserve("s2", "u2", null)).toBe(true); // re-offer of an existing session does not count twice
    expect(m.owned("s1", "u1")?.viewerUserId).toBe("u1");
    expect(m.owned("s1", "u2")).toBeNull();
    expect(m.owned("nope", "u1")).toBeNull();
    m.release("s1");
    expect(m.count()).toBe(1);
    expect(m.reconcile(new Set(["s9"]))).toEqual(["s2"]);
    expect(m.count()).toBe(0);
  });
});

describe("PgmSessionManager.has", () => {
  it("reports reserved ids only", () => {
    const sessions = new PgmSessionManager(2);
    expect(sessions.has("a")).toBe(false);
    sessions.reserve("a", "u", null);
    expect(sessions.has("a")).toBe(true);
    sessions.release("a");
    expect(sessions.has("a")).toBe(false);
  });
});
