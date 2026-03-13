import { checkBridgeHealth } from "./bridge-health-check.js";

describe("checkBridgeHealth", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns a not-running status when config is missing", async () => {
    await expect(checkBridgeHealth(null)).resolves.toEqual({
      running: false,
      reachable: false,
      error: "No bridge configuration",
    });
  });

  it("uses loopback target for 0.0.0.0 and merges relay status", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "1.2.3", uptime: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ connected: true, bridgeId: "bridge-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await checkBridgeHealth({
      host: "0.0.0.0",
      port: 8000,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8000/status",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8000/relay/status",
      expect.objectContaining({ method: "GET" }),
    );
    expect(status.running).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.version).toBe("1.2.3");
    expect(status.relayConnected).toBe(true);
    expect(status.bridgeId).toBe("bridge-1");
  });

  it("returns a clear error on non-json responses", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock.mockResolvedValueOnce(
      new Response("<html>occupied</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await checkBridgeHealth({
      host: "127.0.0.1",
      port: 8000,
    });

    expect(status.running).toBe(false);
    expect(status.reachable).toBe(false);
    expect(status.error).toContain("already in use");
  });
});
