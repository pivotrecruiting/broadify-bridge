import { VmixAdapter } from "./vmix-adapter.js";

const mockFetch = jest.fn();

const okResponse = (body: string) => ({
  ok: true,
  text: () => Promise.resolve(body),
});

describe("VmixAdapter", () => {
  let adapter: VmixAdapter;

  beforeEach(() => {
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
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 8088 })
      ).rejects.toThrow();
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
  });
});
