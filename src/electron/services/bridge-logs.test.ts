import type { BridgeConfig } from "../types.js";
import { fetchBridgeLogs, clearBridgeLogs } from "./bridge-logs.js";

const createBridgeConfig = (host: string, port: number): BridgeConfig => ({
  host,
  port,
});

describe("fetchBridgeLogs", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns error when config is null", async () => {
    await expect(fetchBridgeLogs(null)).resolves.toEqual({
      scope: "bridge",
      lines: 0,
      content: "",
      error: "No bridge config available",
    });
  });

  it("normalizes 0.0.0.0 to 127.0.0.1 and returns logs", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          scope: "bridge",
          lines: 10,
          content: "log line 1\nlog line 2",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchBridgeLogs(createBridgeConfig("0.0.0.0", 8787))
    ).resolves.toEqual({
      scope: "bridge",
      lines: 10,
      content: "log line 1\nlog line 2",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/logs",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) })
    );
  });

  it("passes lines and filter query params when provided", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ scope: "bridge", lines: 5, content: "" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchBridgeLogs(createBridgeConfig("127.0.0.1", 8787), {
      lines: 100,
      filter: "error",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/logs?lines=100&filter=error",
      expect.any(Object)
    );
  });

  it("returns error on non-ok response", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchBridgeLogs(createBridgeConfig("127.0.0.1", 8787))
    ).resolves.toEqual({
      scope: "bridge",
      lines: 0,
      content: "",
      error: "HTTP 500",
    });
  });

  it("returns error when fetch throws", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchBridgeLogs(createBridgeConfig("127.0.0.1", 8787))
    ).resolves.toEqual({
      scope: "bridge",
      lines: 0,
      content: "",
      error: "network down",
    });
  });
});

describe("clearBridgeLogs", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns error when config is null", async () => {
    await expect(clearBridgeLogs(null)).resolves.toEqual({
      scope: "bridge",
      cleared: false,
      error: "No bridge config available",
    });
  });

  it("normalizes 0.0.0.0 to 127.0.0.1 and clears logs", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ scope: "bridge", cleared: true }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      clearBridgeLogs(createBridgeConfig("0.0.0.0", 8787))
    ).resolves.toEqual({
      scope: "bridge",
      cleared: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/logs/clear",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })
    );
  });

  it("returns error on non-ok response", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      clearBridgeLogs(createBridgeConfig("127.0.0.1", 8787))
    ).resolves.toEqual({
      scope: "bridge",
      cleared: false,
      error: "HTTP 403",
    });
  });

  it("returns error when fetch throws", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      clearBridgeLogs(createBridgeConfig("127.0.0.1", 8787))
    ).resolves.toEqual({
      scope: "bridge",
      cleared: false,
      error: "ECONNREFUSED",
    });
  });
});
