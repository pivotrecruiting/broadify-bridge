import { VmixAdapter } from "./vmix-adapter.js";

const mockFetch = jest.fn();

const okResponse = (body: string) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: () => Promise.resolve(body),
});

const notOkResponse = (status: number) => ({
  ok: false,
  status,
  statusText: "Error",
  text: () => Promise.resolve(""),
});

describe("VmixAdapter", () => {
  let adapter: VmixAdapter;

  beforeEach(() => {
    jest.useRealTimers();
    adapter = new VmixAdapter();
    mockFetch.mockReset();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe("connect", () => {
    it("throws when config type is not vmix", async () => {
      await expect(
        adapter.connect({
          type: "atem",
          ip: "10.0.0.1",
          port: 9910,
        })
      ).rejects.toThrow('VmixAdapter only supports type "vmix"');
    });

    it("throws when already connected", async () => {
      mockFetch.mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.2", port: 8088 })
      ).rejects.toThrow("already connected");
    });

    it("connects successfully when GetVersion returns ok", async () => {
      const macroXml =
        '<vmix><macros><macro number="1" name="Macro 1" running="False"/></macros></vmix>';
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse(macroXml));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      expect(adapter.getStatus()).toBe("connected");
      expect(adapter.getMacros()).toHaveLength(1);
    });

    it("throws when GetVersion fails", async () => {
      mockFetch.mockResolvedValue(notOkResponse(404));
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow();
    });

    it("handles ECONNREFUSED and sets error state", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED Connection refused"));
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow("Connection refused");
      expect(adapter.getStatus()).toBe("error");
    });

    it("handles ENOTFOUND as device unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("ENOTFOUND getaddrinfo"));
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow("Device unreachable");
    });

    it("handles ETIMEDOUT as connection timeout", async () => {
      mockFetch.mockRejectedValue(new Error("ETIMEDOUT timeout"));
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow("Connection timeout");
    });

    it("handles EngineError and rethrows", async () => {
      const { EngineError, EngineErrorCode } = await import(
        "../engine-errors.js"
      );
      mockFetch.mockRejectedValue(
        new EngineError(EngineErrorCode.CONNECTION_REFUSED, "Custom", {
          ip: "10.0.0.1",
          port: 8088,
        })
      );
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow("Custom");
    });

    it("handles generic network error", async () => {
      mockFetch.mockRejectedValue(new Error("Unknown network failure"));
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow("Network error");
    });

    it("transitions to error after consecutive polling failures", async () => {
      jest.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(okResponse("29.0.0.0"))
        .mockResolvedValueOnce(
          okResponse(
            '<vmix><macros><macro number="1" name="Macro 1" running="False"/></macros></vmix>'
          )
        )
        .mockRejectedValue(new Error("ECONNREFUSED Connection refused"));

      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      expect(adapter.getStatus()).toBe("connected");

      await jest.advanceTimersByTimeAsync(2000);
      expect(adapter.getStatus()).toBe("connected");

      await jest.advanceTimersByTimeAsync(2000);
      expect(adapter.getStatus()).toBe("error");
      expect(adapter.getState().error).toContain("Connection refused");
    });
  });

  describe("disconnect", () => {
    it("resets state", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await adapter.disconnect();
      expect(adapter.getStatus()).toBe("disconnected");
      expect(adapter.getMacros()).toHaveLength(0);
    });
  });

  describe("runMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.runMacro(1)).rejects.toThrow("not connected");
    });

    it("throws for invalid macro ID", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await expect(adapter.runMacro(0)).rejects.toThrow("Invalid macro ID");
    });

    it("calls MacroStart API when connected", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await adapter.runMacro(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("MacroStart"),
        expect.any(Object)
      );
    });

    it("throws when MacroStart API returns error", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValueOnce(okResponse("<vmix></vmix>"))
        .mockResolvedValueOnce(notOkResponse(500));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await expect(adapter.runMacro(1)).rejects.toThrow("Failed to run macro 1");
    });

    it("marks adapter as error when MacroStart fails with connection error", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValueOnce(okResponse("<vmix></vmix>"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED Connection refused"));

      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await expect(adapter.runMacro(1)).rejects.toThrow("Failed to run macro 1");
      expect(adapter.getStatus()).toBe("error");
    });
  });

  describe("stopMacro", () => {
    it("throws when not connected", async () => {
      await expect(adapter.stopMacro(1)).rejects.toThrow("not connected");
    });

    it("throws for invalid macro ID", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await expect(adapter.stopMacro(0)).rejects.toThrow("Invalid macro ID");
    });

    it("calls MacroStop API when connected", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await adapter.stopMacro(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("MacroStop"),
        expect.any(Object)
      );
    });

    it("throws when MacroStop API returns error", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValueOnce(okResponse("<vmix></vmix>"))
        .mockResolvedValueOnce(notOkResponse(500));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      await expect(adapter.stopMacro(1)).rejects.toThrow(
        "Failed to stop macro 1"
      );
    });
  });

  describe("getMacros", () => {
    it("parses JSON format when XML not present", async () => {
      const macroJson = JSON.stringify({
        macros: [
          { number: 1, name: "Macro 1", running: false },
          { number: 2, name: "Macro 2", running: true },
        ],
      });
      mockFetch
        .mockResolvedValueOnce(okResponse(""))
        .mockResolvedValue(okResponse(macroJson));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      const macros = adapter.getMacros();
      expect(macros).toHaveLength(2);
      expect(macros[0]).toEqual({ id: 1, name: "Macro 1", status: "idle" });
      expect(macros[1]).toEqual({ id: 2, name: "Macro 2", status: "running" });
    });
  });

  describe("onStateChange", () => {
    it("calls callback on state change and returns unsubscribe", async () => {
      const callback = jest.fn();
      const unsubscribe = adapter.onStateChange(callback);
      mockFetch.mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      expect(callback).toHaveBeenCalled();
      unsubscribe();
      callback.mockClear();
      await adapter.disconnect();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("getState", () => {
    it("returns full state after connect", async () => {
      mockFetch.mockResolvedValue(okResponse("<vmix></vmix>"));
      await adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 });
      const state = adapter.getState();
      expect(state.status).toBe("connected");
      expect(state.ip).toBe("10.0.0.1");
      expect(state.port).toBe(8088);
      expect(state.type).toBe("vmix");
    });
  });
});
