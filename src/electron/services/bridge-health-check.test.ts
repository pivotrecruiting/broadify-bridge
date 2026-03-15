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

  it("returns error on HTTP non-2xx response", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock.mockResolvedValueOnce(
      new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await checkBridgeHealth({
      host: "127.0.0.1",
      port: 8000,
    });

    expect(status.running).toBe(false);
    expect(status.reachable).toBe(false);
    expect(status.error).toBe("HTTP 404");
  });

  it("returns port-in-use error when fetch throws with JSON in message", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock.mockRejectedValueOnce(new Error("Failed to parse JSON"));

    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await checkBridgeHealth({
      host: "127.0.0.1",
      port: 8000,
    });

    expect(status.running).toBe(false);
    expect(status.reachable).toBe(false);
    expect(status.error).toContain("already in use");
  });

  it("returns error when relay status check fails but main status succeeds", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "1.0", uptime: 10 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("Network error"));

    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await checkBridgeHealth({
      host: "127.0.0.1",
      port: 8000,
    });

    expect(status.running).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.version).toBe("1.0");
    expect(status.relayConnected).toBe(false);
  });
});

describe("startHealthCheckPolling", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("calls onStatusUpdate and stop clears interval", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { startHealthCheckPolling } = await import(
      "./bridge-health-check.js"
    );
    const onStatusUpdate = jest.fn();

    const stop = startHealthCheckPolling(
      { host: "127.0.0.1", port: 8000 },
      onStatusUpdate,
    );

    await new Promise((r) => setImmediate(r));

    expect(onStatusUpdate).toHaveBeenCalled();
    stop();
  });

  it("uses isProcessRunning to override running flag", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    fetchMock.mockResolvedValue(
      new Response("error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    const { startHealthCheckPolling } = await import(
      "./bridge-health-check.js"
    );
    const onStatusUpdate = jest.fn();
    const isProcessRunning = jest.fn().mockReturnValue(true);

    const stop = startHealthCheckPolling(
      { host: "127.0.0.1", port: 8000 },
      onStatusUpdate,
      isProcessRunning,
    );

    await new Promise((r) => setImmediate(r));

    expect(onStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ running: true, reachable: false }),
    );

    stop();
  });
});
