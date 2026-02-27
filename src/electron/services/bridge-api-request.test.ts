import {
  buildBridgeApiHeaders,
  buildBridgeApiUrl,
  createBridgeApiRequest,
  getBridgeApiTimeoutMs,
} from "./bridge-api-request.js";

describe("bridge-api-request", () => {
  it("uses loopback when host is 0.0.0.0", () => {
    expect(
      buildBridgeApiUrl({ host: "0.0.0.0", port: 8000 }, "/status"),
    ).toBe("http://127.0.0.1:8000/status");
  });

  it("uses endpoint-specific timeouts", () => {
    expect(getBridgeApiTimeoutMs("/engine/connect")).toBe(15000);
    expect(getBridgeApiTimeoutMs("/engine/status")).toBe(10000);
  });

  it("adds content-type only when body exists and header is missing", () => {
    expect(buildBridgeApiHeaders({})).toEqual({});
    expect(buildBridgeApiHeaders({ body: "{\"x\":1}" })).toEqual({
      "Content-Type": "application/json",
    });
    expect(
      buildBridgeApiHeaders({
        body: "{\"x\":1}",
        headers: { "Content-Type": "text/plain" },
      }),
    ).toEqual({
      "Content-Type": "text/plain",
    });
  });

  it("throws when bridge config is missing", async () => {
    const request = createBridgeApiRequest(() => null);
    await expect(request("/status")).rejects.toThrow("Bridge is not running");
  });

  it("calls fetch with normalized url and parsed json response", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const request = createBridgeApiRequest(
      () => ({ host: "0.0.0.0", port: 8010 }),
      fetchMock as unknown as typeof fetch,
    );

    await expect(request("/status")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8010/status",
      expect.objectContaining({
        headers: {},
      }),
    );
  });

  it("uses 15s timeout for /engine/connect", async () => {
    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const request = createBridgeApiRequest(
      () => ({ host: "127.0.0.1", port: 8010 }),
      fetchMock as unknown as typeof fetch,
    );

    await request("/engine/connect", { method: "POST", body: "{}" });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15000);
    timeoutSpy.mockRestore();
  });

  it("maps non-ok response to error message", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "invalid request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const request = createBridgeApiRequest(
      () => ({ host: "127.0.0.1", port: 8010 }),
      fetchMock as unknown as typeof fetch,
    );

    await expect(request("/engine/connect")).rejects.toThrow("invalid request");
  });
});
