import { TricasterAdapter } from "./tricaster-adapter.js";

const mockFetch = jest.fn();

/** Response mock with .json() for Tricaster API. */
const okJsonResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: () => Promise.resolve(data),
  text: () => Promise.resolve(JSON.stringify(data)),
});

/** Response mock for status/API check (no json needed). */
const okStatusResponse = () => ({
  ok: true,
  status: 200,
  statusText: "OK",
});

const notOkResponse = (status: number) => ({
  ok: false,
  status,
  statusText: "Error",
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(""),
});

describe("TricasterAdapter", () => {
  let adapter: TricasterAdapter;

  beforeEach(() => {
    adapter = new TricasterAdapter();
    mockFetch.mockReset();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe("connect", () => {
    it("throws when config type is not tricaster", async () => {
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow('TricasterAdapter only supports type "tricaster"');
    });

    it("throws when already connected", async () => {
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 });
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.2", port: 8080 })
      ).rejects.toThrow("already connected");
    });

    it("connects successfully when status API returns ok", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "192.168.1.100",
        port: 8080,
      });
      expect(adapter.getStatus()).toBe("connected");
    });

    it("connects when status fails but /api returns ok", async () => {
      mockFetch
        .mockResolvedValueOnce(notOkResponse(404))
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      expect(adapter.getStatus()).toBe("connected");
    });

    it("throws when both status and /api fail with non-404", async () => {
      mockFetch
        .mockResolvedValueOnce(notOkResponse(500))
        .mockResolvedValueOnce(notOkResponse(500));
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 })
      ).rejects.toThrow("Network error");
    });

    it("handles ECONNREFUSED and sets error state", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED Connection refused"));
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 })
      ).rejects.toThrow("Connection refused");
      expect(adapter.getStatus()).toBe("error");
    });

    it("handles ENOTFOUND as device unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("ENOTFOUND getaddrinfo"));
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 })
      ).rejects.toThrow("Device unreachable");
    });

    it("handles ETIMEDOUT as connection timeout", async () => {
      mockFetch.mockRejectedValue(new Error("ETIMEDOUT timeout"));
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 })
      ).rejects.toThrow("Connection timeout");
    });

    it("handles EngineError and rethrows", async () => {
      const { EngineError, EngineErrorCode } = await import(
        "../engine-errors.js"
      );
      mockFetch.mockRejectedValue(
        new EngineError(EngineErrorCode.CONNECTION_REFUSED, "Custom", {
          ip: "10.0.0.1",
          port: 8080,
        })
      );
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 })
      ).rejects.toThrow("Custom");
    });

    it("handles generic network error", async () => {
      mockFetch.mockRejectedValue(new Error("Unknown network failure"));
      await expect(
        adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 })
      ).rejects.toThrow("Network error");
    });
  });

  describe("disconnect", () => {
    it("resets state", async () => {
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({ type: "tricaster", ip: "10.0.0.1", port: 8080 });
      await adapter.disconnect();
      expect(adapter.getStatus()).toBe("disconnected");
    });
  });

  describe("getStatus", () => {
    it("returns disconnected initially", () => {
      expect(adapter.getStatus()).toBe("disconnected");
    });
  });

  describe("getMacros", () => {
    it("returns macros after connect with macros from API", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(
          okJsonResponse([
            { id: 1, name: "Macro 1", running: false },
            { id: 2, name: "Macro 2", running: true },
          ])
        );
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      const macros = adapter.getMacros();
      expect(macros).toHaveLength(2);
      expect(macros[0]).toEqual({ id: 1, name: "Macro 1", status: "idle" });
      expect(macros[1]).toEqual({ id: 2, name: "Macro 2", status: "running" });
    });

    it("parses macros from { macros: [...] } format", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(
          okJsonResponse({
            macros: [
              { id: 3, name: "M3", running: false },
              { number: 4, name: "M4", running: true },
            ],
          })
        );
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      const macros = adapter.getMacros();
      expect(macros).toHaveLength(2);
      expect(macros[0]).toEqual({ id: 3, name: "M3", status: "idle" });
      expect(macros[1]).toEqual({ id: 4, name: "M4", status: "running" });
    });

    it("parses macros from { macro: [...] } format", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(
          okJsonResponse({
            macro: [{ number: 5, name: "Macro 5", running: false }],
          })
        );
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      const macros = adapter.getMacros();
      expect(macros).toHaveLength(1);
      expect(macros[0]).toEqual({ id: 5, name: "Macro 5", status: "idle" });
    });
  });

  describe("runMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.runMacro(1)).rejects.toThrow("not connected");
    });

    it("throws for invalid macro ID < 1", async () => {
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await expect(adapter.runMacro(0)).rejects.toThrow("Invalid macro ID");
    });

    it("calls /api/macro/{id}/run and updates macros", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValueOnce(okJsonResponse({ macros: [] }))
        .mockResolvedValueOnce(okJsonResponse({ macros: [] }))
        .mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await adapter.runMacro(1);
      const postCalls = mockFetch.mock.calls.filter(
        (c: [string, RequestInit]) => c[1]?.method === "POST"
      );
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/macro/1/run"),
        expect.any(Object)
      );
    });

    it("tries /api/macros/{id}/run if first fails", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValueOnce(okJsonResponse({ macros: [] }))
        .mockResolvedValueOnce(notOkResponse(404))
        .mockResolvedValueOnce(okJsonResponse({ macros: [] }))
        .mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await adapter.runMacro(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/macros/2/run"),
        expect.any(Object)
      );
    });

    it("throws when all run endpoints fail", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(notOkResponse(500));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await expect(adapter.runMacro(1)).rejects.toThrow("Failed to run macro 1");
    });
  });

  describe("stopMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.stopMacro(1)).rejects.toThrow("not connected");
    });

    it("throws for invalid macro ID < 1", async () => {
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await expect(adapter.stopMacro(0)).rejects.toThrow("Invalid macro ID");
    });

    it("calls /api/macro/{id}/stop when connected", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValueOnce(okJsonResponse({ macros: [] }))
        .mockResolvedValueOnce(okJsonResponse({ macros: [] }))
        .mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await adapter.stopMacro(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/macro/1/stop"),
        expect.any(Object)
      );
    });

    it("throws when all stop endpoints fail", async () => {
      mockFetch
        .mockResolvedValueOnce(okStatusResponse())
        .mockResolvedValue(notOkResponse(500));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      await expect(adapter.stopMacro(1)).rejects.toThrow("Failed to stop macro 1");
    });
  });

  describe("onStateChange", () => {
    it("calls callback on state change and returns unsubscribe", async () => {
      const callback = jest.fn();
      const unsubscribe = adapter.onStateChange(callback);
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      expect(callback).toHaveBeenCalled();
      unsubscribe();
      callback.mockClear();
      await adapter.disconnect();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("getState", () => {
    it("returns full state after connect", async () => {
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({
        type: "tricaster",
        ip: "10.0.0.1",
        port: 8080,
      });
      const state = adapter.getState();
      expect(state.status).toBe("connected");
      expect(state.ip).toBe("10.0.0.1");
      expect(state.port).toBe(8080);
      expect(state.type).toBe("tricaster");
    });
  });
});
