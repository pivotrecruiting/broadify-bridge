import { TricasterAdapter } from "./tricaster-adapter.js";

const mockFetch = jest.fn();

/** Response mock with .text() for vMix-style APIs. */
const okResponse = (body: string) => ({
  ok: true,
  text: () => Promise.resolve(body),
});

/** Response mock with .json() for Tricaster API (parseMacrosFromResponse). */
const okJsonResponse = (data: unknown) => ({
  ok: true,
  json: () => Promise.resolve(data),
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

    it("connects successfully when API returns ok", async () => {
      mockFetch.mockResolvedValue(okJsonResponse({ macros: [] }));
      await adapter.connect({ type: "tricaster", ip: "192.168.1.100", port: 8080 });
      expect(adapter.getStatus()).toBe("connected");
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
});
