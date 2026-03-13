import { WebSocket } from "ws";
import { RelayClient } from "./relay-client.js";

class FakeWebSocket {
  public readyState = WebSocket.CONNECTING;
  public sent: string[] = [];
  public closeCalls = 0;
  public pingCalls = 0;
  public terminateCalls = 0;

  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pingCalls += 1;
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason, "utf-8"));
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receiveJson(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

const createLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("RelayClient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends bridge_hello after the socket opens", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient(
      "bridge-1",
      "ws://relay.test",
      logger,
      "Studio A",
      {
        createWebSocket: () => socket,
        getVersion: () => "1.2.3",
        getEnrollmentPublicKey: async () => ({
          keyId: "bridge-key-1",
          algorithm: "ed25519",
          publicKeyPem: "pem",
        }),
      },
    );

    await client.connect();
    socket.open();
    await flushAsync();

    expect(client.isConnected()).toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual(
      expect.objectContaining({
        type: "bridge_hello",
        bridgeId: "bridge-1",
        protocolVersion: 2,
        sessionId: expect.any(String),
        lastProcessedSequence: 0,
        version: "1.2.3",
        bridgeName: "Studio A",
        auth: {
          bridgeKeyId: "bridge-key-1",
          algorithm: "ed25519",
        },
      }),
    );
  });

  it("schedules a reconnect after close", async () => {
    const sockets: FakeWebSocket[] = [];
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    await client.connect();
    sockets[0].open();
    await flushAsync();

    sockets[0].emit("close");

    expect(sockets).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it("disconnect closes the socket and prevents reconnects", async () => {
    const sockets: FakeWebSocket[] = [];
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    await client.connect();
    sockets[0].open();
    await flushAsync();

    await client.disconnect();
    await jest.advanceTimersByTimeAsync(1000);

    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(client.isConnected()).toBe(false);
  });

  it("terminates an idle connection when the watchdog expires", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      relayIdleTimeoutMs: 100,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    await client.connect();
    socket.open();
    await flushAsync();

    await jest.advanceTimersByTimeAsync(100);

    expect(socket.terminateCalls).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Relay connection idle for >100ms, terminating socket",
    );
  });

  it("sends active heartbeat pings and resets on pong", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      relayHeartbeatIntervalMs: 100,
      relayHeartbeatMaxMisses: 2,
      setIntervalFn: setInterval,
      clearIntervalFn: clearInterval,
    });

    await client.connect();
    socket.open();
    await flushAsync();

    await jest.advanceTimersByTimeAsync(100);
    expect(socket.pingCalls).toBe(1);

    socket.emit("pong");

    await jest.advanceTimersByTimeAsync(100);
    expect(socket.pingCalls).toBe(2);
    expect(socket.terminateCalls).toBe(0);
  });

  it("terminates the socket after repeated missed heartbeats", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      relayHeartbeatIntervalMs: 100,
      relayHeartbeatMaxMisses: 2,
      setIntervalFn: setInterval,
      clearIntervalFn: clearInterval,
    });

    await client.connect();
    socket.open();
    await flushAsync();

    await jest.advanceTimersByTimeAsync(300);

    expect(socket.pingCalls).toBe(2);
    expect(socket.terminateCalls).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Relay heartbeat missed 2 time(s), terminating socket",
    );
  });

  it("logs close code and reason when the relay closes the socket", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    await client.connect();
    socket.open();
    await flushAsync();

    socket.close(1012, "Reconnect for bridge auth");

    expect(logger.warn).toHaveBeenCalledWith(
      "Disconnected from relay server (code: 1012, reason: Reconnect for bridge auth)",
    );
  });

  it("responds to a bridge auth challenge", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      signAuthChallenge: async () => ({
        bridgeKeyId: "bridge-key-1",
        algorithm: "ed25519",
        signature: "sig-123",
      }),
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "bridge_auth_challenge",
      bridgeId: "bridge-1",
      challengeId: "challenge-1",
      nonce: "nonce-1",
      iat: 1000,
      exp: 1030,
      bridgeKeyId: "bridge-key-1",
      algorithm: "ed25519",
    });
    await flushAsync();

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "bridge_auth_response",
      bridgeId: "bridge-1",
      challengeId: "challenge-1",
      bridgeKeyId: "bridge-key-1",
      algorithm: "ed25519",
      signature: "sig-123",
    });
  });

  it("acknowledges a relay command before sending the result", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => undefined,
      isRelayCommand: () => true,
      handleCommand: async () => ({
        success: true,
        data: { ok: true },
      }),
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "command",
      requestId: "req-1",
      sequence: 7,
      command: "engine_connect",
      payload: { foo: "bar" },
    });
    await flushAsync();

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "command_received",
      requestId: "req-1",
      bridgeId: "bridge-1",
      sequence: 7,
    });
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "command_result",
      requestId: "req-1",
      success: true,
      data: { ok: true },
    });
  });

  it("deduplicates replayed requestIds and reuses cached command_result", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const handleCommand = jest.fn(async () => ({
      success: true,
      data: { executed: true },
    }));
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => undefined,
      isRelayCommand: () => true,
      handleCommand,
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "command",
      requestId: "req-dup",
      sequence: 11,
      command: "engine_get_status",
      payload: {},
    });
    await flushAsync();

    socket.receiveJson({
      type: "command",
      requestId: "req-dup",
      sequence: 11,
      command: "engine_get_status",
      payload: {},
    });
    await flushAsync();

    expect(handleCommand).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(4);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "command_received",
      requestId: "req-dup",
      bridgeId: "bridge-1",
      sequence: 11,
    });
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "command_result",
      requestId: "req-dup",
      success: true,
      data: { executed: true },
    });
    expect(JSON.parse(socket.sent[2])).toEqual({
      type: "command_received",
      requestId: "req-dup",
      bridgeId: "bridge-1",
      sequence: 11,
    });
    expect(JSON.parse(socket.sent[3])).toEqual({
      type: "command_result",
      requestId: "req-dup",
      success: true,
      data: { executed: true },
    });
  });

  it("expires dedupe cache entries after configured TTL", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const handleCommand = jest.fn(async () => ({
      success: true,
      data: { fresh: true },
    }));
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => undefined,
      isRelayCommand: () => true,
      handleCommand,
      commandDedupeTtlMs: 10,
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "command",
      requestId: "req-expire",
      command: "engine_get_status",
      payload: {},
    });
    await flushAsync();

    await jest.advanceTimersByTimeAsync(11);

    socket.receiveJson({
      type: "command",
      requestId: "req-expire",
      command: "engine_get_status",
      payload: {},
    });
    await flushAsync();

    expect(handleCommand).toHaveBeenCalledTimes(2);
  });

  it("publishes resync snapshots after bridge_auth_ok", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const handleCommand = jest
      .fn()
      .mockResolvedValueOnce({ success: true, data: { bridge: "ok" } })
      .mockResolvedValueOnce({ success: true, data: { engine: "ok" } })
      .mockResolvedValueOnce({ success: true, data: { outputs: [] } })
      .mockResolvedValueOnce({ success: true, data: { graphics: [] } });

    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      handleCommand,
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "bridge_auth_ok",
      bridgeId: "bridge-1",
    });
    for (let index = 0; index < 6; index += 1) {
      await flushAsync();
    }

    const events = socket.sent
      .map((entry) => JSON.parse(entry))
      .filter((entry) => entry.type === "bridge_event")
      .map((entry) => entry.event);

    expect(events).toEqual([
      "bridge_resync_required",
      "bridge_status_snapshot",
      "engine_status_snapshot",
      "outputs_snapshot",
      "graphics_snapshot",
    ]);
  });
});
