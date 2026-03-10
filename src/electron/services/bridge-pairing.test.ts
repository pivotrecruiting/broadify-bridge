import { BridgePairingService } from "./bridge-pairing.js";

describe("BridgePairingService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts a pairing session with an 8-character code and ttl metadata", () => {
    const service = new BridgePairingService(30_000);

    const info = service.startPairing();

    expect(info.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(info.createdAt).toBe(Date.now());
    expect(info.expiresAt).toBe(Date.now() + 30_000);
    expect(info.ttlMs).toBe(30_000);
    expect(info.expired).toBe(false);
  });

  it("marks pairing info as expired once ttl has elapsed", () => {
    const service = new BridgePairingService(1_000);
    service.startPairing();

    jest.advanceTimersByTime(999);
    expect(service.getPairingInfo()).toEqual(
      expect.objectContaining({ expired: false })
    );

    jest.advanceTimersByTime(1);
    expect(service.getPairingInfo()).toEqual(
      expect.objectContaining({ expired: true })
    );
  });

  it("clears the active pairing session", () => {
    const service = new BridgePairingService();
    service.startPairing();

    service.clear();

    expect(service.getPairingInfo()).toBeNull();
  });
});
