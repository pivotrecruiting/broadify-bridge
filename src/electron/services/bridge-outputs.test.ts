import type { BridgeConfig } from "../types.js";
import { fetchBridgeOutputs } from "./bridge-outputs.js";

const createBridgeConfig = (host: string, port: number): BridgeConfig => ({
  host,
  port,
});

describe("fetchBridgeOutputs", () => {
  const originalFetch = global.fetch;
  const originalDebugFlag = process.env.BRIDGE_LOG_OUTPUTS;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDebugFlag) {
      process.env.BRIDGE_LOG_OUTPUTS = originalDebugFlag;
    } else {
      delete process.env.BRIDGE_LOG_OUTPUTS;
    }
  });

  it("returns null when bridge config is missing", async () => {
    await expect(fetchBridgeOutputs(null)).resolves.toBeNull();
  });

  it("normalizes 0.0.0.0 to loopback and returns parsed outputs", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output1: [{ id: "display-1", name: "Display 1", type: "display", available: true }],
          output2: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchBridgeOutputs(createBridgeConfig("0.0.0.0", 8787))
    ).resolves.toEqual({
      output1: [{ id: "display-1", name: "Display 1", type: "display", available: true }],
      output2: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/outputs",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("returns null for non-ok responses", async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchBridgeOutputs(createBridgeConfig("127.0.0.1", 8787))
    ).resolves.toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchBridgeOutputs(createBridgeConfig("127.0.0.1", 8787))
    ).resolves.toBeNull();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
