import { createServer, type Server, type Socket } from "net";
import type { AddressInfo } from "net";
import {
  RodecasterAdapter,
  buildRodecasterMacroCatalog,
} from "./rodecaster-adapter.js";
import { frameRcvPacket, RcvFrameSplitter } from "./rcv-frame-codec.js";
import {
  encodeOscMessage,
  decodeOscPacket,
  type OscMessageT,
} from "./rcv-osc.js";
import { EngineError, EngineErrorCode } from "../engine-errors.js";
import type { EngineStateT } from "../../engine-types.js";

/** Encode an OSC message whose single argument is a blob (",b"). */
function encodeBlobMessage(address: string, blob: Buffer): Buffer {
  const header = encodeOscMessage(address); // address + ","
  const withTag = Buffer.from(header);
  // Rewrite the empty type tag string "," into ",b" (same padded width).
  withTag[withTag.length - 3] = "b".charCodeAt(0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(blob.length, 0);
  const padding = Buffer.alloc(((blob.length + 3) & ~0x03) - blob.length);
  return Buffer.concat([withTag, size, blob, padding]);
}

/** Minimal in-process stand-in for the RCV's TCP OSC endpoint. */
class MockRcvServer {
  private server: Server | null = null;
  private client: Socket | null = null;
  private splitter = new RcvFrameSplitter();
  readonly received: OscMessageT[] = [];
  private waiters: Array<() => void> = [];
  private clientWaiters: Array<() => void> = [];

  async start(): Promise<number> {
    this.server = createServer((socket) => {
      this.client = socket;
      const clientWaiters = this.clientWaiters;
      this.clientWaiters = [];
      for (const wake of clientWaiters) wake();
      socket.on("data", (chunk) => {
        for (const frame of this.splitter.push(chunk)) {
          for (const message of decodeOscPacket(frame)) {
            this.received.push(message);
          }
        }
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
      });
      socket.on("error", () => {
        // Client teardown races are irrelevant for the assertions.
      });
    });

    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve)
    );
    return (this.server!.address() as AddressInfo).port;
  }

  /** Resolve once the adapter's TCP connection reached the server. */
  waitForClient(timeoutMs = 2000): Promise<void> {
    if (this.client) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for the client socket")),
        timeoutMs
      );
      this.clientWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Resolve once a received message satisfies the predicate. */
  waitForMessage(
    predicate: (message: OscMessageT) => boolean,
    timeoutMs = 2000
  ): Promise<OscMessageT> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const match = this.received.find(predicate);
        if (match) {
          clearTimeout(timer);
          resolve(match);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for message. Received: ${JSON.stringify(
              this.received
            )}`
          )
        );
      }, timeoutMs);
      if (check()) return;
      const poll = () => {
        if (!check()) this.waiters.push(poll);
      };
      this.waiters.push(poll);
    });
  }

  push(address: string, args: ReadonlyArray<number | string> = []): void {
    this.client?.write(frameRcvPacket(encodeOscMessage(address, args)));
  }

  pushRaw(payload: Buffer): void {
    this.client?.write(frameRcvPacket(payload));
  }

  destroyClient(): void {
    this.client?.destroy();
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}

function waitForState(
  adapter: RodecasterAdapter,
  predicate: (state: EngineStateT) => boolean,
  timeoutMs = 2000
): Promise<EngineStateT> {
  return new Promise((resolve, reject) => {
    const current = adapter.getState();
    if (predicate(current)) {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for state. Last: ${JSON.stringify(
            adapter.getState()
          )}`
        )
      );
    }, timeoutMs);
    const unsubscribe = adapter.onStateChange((state) => {
      if (predicate(state)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(state);
      }
    });
  });
}

function macroStatus(state: EngineStateT, id: number): string | undefined {
  return state.macros.find((macro) => macro.id === id)?.status;
}

describe("buildRodecasterMacroCatalog", () => {
  it("exposes the documented stable ID ranges", () => {
    const macros = buildRodecasterMacroCatalog();
    const byId = new Map(macros.map((macro) => [macro.id, macro.name]));

    expect(byId.get(1)).toBe("Scene 1");
    expect(byId.get(7)).toBe("Scene 7");
    expect(byId.get(11)).toBe("Overlay 1 Toggle");
    expect(byId.get(17)).toBe("Overlay 7 Toggle");
    expect(byId.get(21)).toBe("Media 1");
    expect(byId.get(31)).toBe("Cut");
    expect(byId.get(32)).toBe("Auto");
    expect(byId.get(41)).toBe("Transition Fade");
    expect(byId.get(51)).toBe("Record Start");
    expect(byId.get(54)).toBe("Stream Stop");
    expect(macros).toHaveLength(30);
    expect(macros.every((macro) => macro.status === "idle")).toBe(true);
  });
});

describe("RodecasterAdapter", () => {
  let server: MockRcvServer;
  let port: number;
  let adapter: RodecasterAdapter;

  beforeEach(async () => {
    server = new MockRcvServer();
    port = await server.start();
    adapter = new RodecasterAdapter();
  });

  afterEach(async () => {
    await adapter.disconnect();
    await server.close();
  });

  async function connect(): Promise<void> {
    await adapter.connect({ type: "rodecaster", ip: "127.0.0.1", port });
    // The server processes its "connection" event on its own tick; wait for
    // it so pushes to the adapter cannot be dropped silently.
    await server.waitForClient();
  }

  it("connects, subscribes to /show and /remote and exposes the catalog", async () => {
    await connect();

    expect(adapter.getStatus()).toBe("connected");
    expect(adapter.getMacros()).toHaveLength(30);

    await server.waitForMessage((m) => m.address === "/show");
    await server.waitForMessage((m) => m.address === "/remote");
  });

  it("rejects non-rodecaster configs and double connects", async () => {
    await expect(
      adapter.connect({ type: "atem", ip: "127.0.0.1", port })
    ).rejects.toThrow(/only supports type "rodecaster"/);

    await connect();
    await expect(connect()).rejects.toThrow(/already connected/);
  });

  it("maps macros onto the documented OSC commands", async () => {
    await connect();

    await adapter.runMacro(3);
    await server.waitForMessage(
      (m) => m.address === "/device/scene" && m.args[0] === 3
    );

    await adapter.runMacro(12);
    await server.waitForMessage(
      (m) => m.address === "/device/toggleOverlay" && m.args[0] === 2
    );

    await adapter.runMacro(31);
    await server.waitForMessage(
      (m) =>
        m.address === "/device/button" &&
        m.args[0] === 105 &&
        m.args[1] === 1
    );

    await adapter.runMacro(43);
    await server.waitForMessage(
      (m) => m.address === "/show/transition" && m.args[0] === "wipe"
    );
    await server.waitForMessage(
      (m) =>
        m.address === "/show/transition_data" && m.args[0] === "leftright"
    );

    await adapter.runMacro(51);
    await server.waitForMessage(
      (m) => m.address === "/show/record" && m.args[0] === 1
    );
  });

  it("rejects unknown macro IDs", async () => {
    await connect();
    await expect(adapter.runMacro(99)).rejects.toThrow(/Unknown/);
    await expect(adapter.stopMacro(99)).rejects.toThrow(/Unknown/);
  });

  it("rejects macros while disconnected", async () => {
    await expect(adapter.runMacro(1)).rejects.toThrow(/not connected/);
  });

  it("tracks the live scene from /show/pgmcurrent pushes", async () => {
    await connect();

    server.push("/show/pgmcurrent", ["scene", 3]);
    let state = await waitForState(
      adapter,
      (s) => macroStatus(s, 3) === "running"
    );
    expect(macroStatus(state, 1)).toBe("idle");

    server.push("/show/pgmcurrent", ["scene", 1]);
    state = await waitForState(
      adapter,
      (s) => macroStatus(s, 1) === "running"
    );
    expect(macroStatus(state, 3)).toBe("idle");

    // Media live clears the scene feedback.
    server.push("/show/pgmcurrent", ["media", 2]);
    state = await waitForState(
      adapter,
      (s) => macroStatus(s, 22) === "running"
    );
    expect(macroStatus(state, 1)).toBe("idle");
  });

  it("applies the initial /show XML dump (blob) to scene and overlay state", async () => {
    await connect();

    const xml = Buffer.from(
      '<RcvShow name="Test" PgmScene="2" PvwScene="0" PgmOverlay="1" PvwOverlay="-1"></RcvShow>',
      "utf8"
    );
    server.pushRaw(encodeBlobMessage("/show", xml));

    const state = await waitForState(
      adapter,
      (s) => macroStatus(s, 3) === "running" && macroStatus(s, 12) === "running"
    );
    expect(macroStatus(state, 1)).toBe("idle");
    expect(macroStatus(state, 11)).toBe("idle");
  });

  it("tracks overlay, record and stream state and stops them via stopMacro", async () => {
    await connect();

    server.push("/show/PgmOverlay", [0]);
    await waitForState(adapter, (s) => macroStatus(s, 11) === "running");

    server.push("/show/PgmOverlay", [-1]);
    await waitForState(adapter, (s) => macroStatus(s, 11) === "idle");

    server.push("/show/record", [1]);
    await waitForState(adapter, (s) => macroStatus(s, 51) === "running");

    await adapter.stopMacro(51);
    await server.waitForMessage(
      (m) => m.address === "/show/record" && m.args[0] === 0
    );

    server.push("/show/live", [1]);
    await waitForState(adapter, (s) => macroStatus(s, 53) === "running");

    await adapter.stopMacro(53);
    await server.waitForMessage(
      (m) => m.address === "/show/live" && m.args[0] === 0
    );

    await adapter.stopMacro(11);
    await server.waitForMessage(
      (m) => m.address === "/device/toggleOverlay" && m.args[0] === 1
    );
  });

  it("treats stop for momentary macros as a no-op", async () => {
    await connect();
    const before = server.received.length;

    await adapter.stopMacro(1); // scene
    await adapter.stopMacro(31); // cut

    // A sentinel command proves nothing was sent in between.
    await adapter.runMacro(2);
    await server.waitForMessage(
      (m) => m.address === "/device/scene" && m.args[0] === 2
    );
    const sent = server.received.slice(before);
    expect(
      sent.filter((m) => !["/show", "/remote"].includes(m.address))
    ).toEqual([{ address: "/device/scene", args: [2] }]);
  });

  it("drops to an error state with NETWORK_ERROR when the socket dies", async () => {
    await connect();

    server.destroyClient();

    const state = await waitForState(adapter, (s) => s.status === "error");
    expect(state.errorCode).toBe(EngineErrorCode.NETWORK_ERROR);
    expect(state.error).toContain("was lost");
  });

  it("classifies a refused connection as CONNECTION_REFUSED", async () => {
    const deadServer = new MockRcvServer();
    const deadPort = await deadServer.start();
    await deadServer.close();

    let thrown: unknown;
    try {
      await adapter.connect({
        type: "rodecaster",
        ip: "127.0.0.1",
        port: deadPort,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EngineError);
    expect((thrown as EngineError).code).toBe(
      EngineErrorCode.CONNECTION_REFUSED
    );
    expect(adapter.getStatus()).toBe("error");
  });

  it("resets on disconnect and supports a fresh connect afterwards", async () => {
    await connect();
    await adapter.disconnect();

    const state = adapter.getState();
    expect(state.status).toBe("disconnected");
    expect(state.macros).toEqual([]);
    expect(state.ip).toBeUndefined();

    await connect();
    expect(adapter.getStatus()).toBe("connected");
    expect(adapter.getMacros()).toHaveLength(30);
  });
});
