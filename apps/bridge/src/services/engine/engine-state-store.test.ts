import { EngineStateStore } from "./engine-state-store.js";

describe("EngineStateStore", () => {
  let store: EngineStateStore;

  beforeEach(() => {
    store = new EngineStateStore();
  });

  describe("getState", () => {
    it("returns initial disconnected state", () => {
      expect(store.getState()).toEqual({
        status: "disconnected",
        macros: [],
      });
    });

    it("returns copy of state, not reference", () => {
      store.setState({ macros: [{ id: "m1", name: "Macro 1" }] });
      const state1 = store.getState();
      const state2 = store.getState();
      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });
  });

  describe("setState", () => {
    it("merges partial updates", () => {
      store.setState({ status: "connected" });
      expect(store.getState().status).toBe("connected");
    });

    it("sets connectedSince when status becomes connected", () => {
      const before = Date.now();
      store.setState({ status: "connected" });
      const after = Date.now();
      const since = store.getConnectedSince();
      expect(since).not.toBeNull();
      expect(since!).toBeGreaterThanOrEqual(before);
      expect(since!).toBeLessThanOrEqual(after + 1);
    });

    it("clears connectedSince when status becomes disconnected", () => {
      store.setState({ status: "connected" });
      expect(store.getConnectedSince()).not.toBeNull();
      store.setState({ status: "disconnected" });
      expect(store.getConnectedSince()).toBeNull();
    });

    it("clears connectedSince when status becomes error", () => {
      store.setState({ status: "connected" });
      store.setState({ status: "error", error: "Connection lost" });
      expect(store.getConnectedSince()).toBeNull();
    });

    it("tracks last error", () => {
      store.setState({ error: "Connection refused" });
      expect(store.getLastError()).toBe("Connection refused");
    });

    it("clears last error when status becomes connected", () => {
      store.setState({ error: "Previous error" });
      store.setState({ status: "connected" });
      expect(store.getLastError()).toBeNull();
    });

    it("adds lastUpdate timestamp", () => {
      const before = Date.now();
      store.setState({ status: "connected" });
      const state = store.getState();
      expect(state.lastUpdate).toBeDefined();
      expect(state.lastUpdate!).toBeGreaterThanOrEqual(before);
    });
  });

  describe("reset", () => {
    it("resets to disconnected state", () => {
      store.setState({ status: "connected", macros: [{ id: "m1", name: "M1" }] });
      store.reset();
      expect(store.getState()).toEqual({ status: "disconnected", macros: [] });
    });

    it("clears connectedSince and lastError", () => {
      store.setState({ status: "connected", error: "err" });
      store.reset();
      expect(store.getConnectedSince()).toBeNull();
      expect(store.getLastError()).toBeNull();
    });
  });
});
