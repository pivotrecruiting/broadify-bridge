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
    if (this.sendThrows) {
      throw new Error("send failed");
    }
    this.sent.push(data);
  }

  sendThrows = false;

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
      .map((entry) => ({
        event: entry.event,
        data: entry.data,
      }));

    expect(events.map((entry) => entry.event)).toEqual([
      "bridge_resync_required",
      "bridge_status_snapshot",
      "engine_status_snapshot",
      "outputs_snapshot",
      "graphics_snapshot",
    ]);
    expect(
      events.find((entry) => entry.event === "engine_status_snapshot")?.data
    ).toEqual(
      expect.objectContaining({
        reason: "bridge_auth_ok",
        at: expect.any(Number),
        snapshot: { engine: "ok" },
      })
    );
  });

  it("does not connect when already connecting", async () => {
    const socket = new FakeWebSocket();
    const createWebSocket = jest.fn(() => socket);
    const client = new RelayClient("bridge-1", "ws://relay.test", createLogger(), undefined, {
      createWebSocket: (url) => createWebSocket(url),
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    void client.connect();
    await flushAsync();
    void client.connect();
    await flushAsync();
    expect(createWebSocket).toHaveBeenCalledTimes(1);
  });

  it("does not connect when already connected and logs debug", async () => {
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
    expect(client.isConnected()).toBe(true);

    await client.connect();
    expect(logger.debug).toHaveBeenCalledWith("Already connected to relay");
  });

  it("does not connect when shutting down", async () => {
    const socket = new FakeWebSocket();
    const createWebSocket = jest.fn(() => socket);
    const client = new RelayClient("bridge-1", "ws://relay.test", createLogger(), undefined, {
      createWebSocket: (url) => createWebSocket(url),
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    await client.disconnect();
    await client.connect();
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it("logs generic disconnect when close has no code or reason", async () => {
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
    socket.emit("close");
    expect(logger.warn).toHaveBeenCalledWith("Disconnected from relay server");
  });

  it("sends bridge_hello without auth when getEnrollmentPublicKey rejects", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no enrollment key");
      },
      getVersion: () => "1.0.0",
    });

    await client.connect();
    socket.open();
    await flushAsync();

    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    const hello = JSON.parse(socket.sent[0]);
    expect(hello.type).toBe("bridge_hello");
    expect(hello.bridgeId).toBe("bridge-1");
    expect(hello.version).toBe("1.0.0");
    expect(hello.auth).toBeUndefined();
  });

  it("drops message exceeding size limit and logs warning", async () => {
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
    socket.sent = [];

    const huge = JSON.stringify({
      type: "command",
      requestId: "req-1",
      command: "engine_get_status",
      payload: {},
    }) + "x".repeat(3 * 1024 * 1024);
    socket.emit("message", huge);
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Dropped relay message exceeding size limit/)
    );
    expect(socket.sent).toHaveLength(0);
  });

  it("drops empty message and logs warning", async () => {
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
    socket.sent = [];

    socket.emit("message", Buffer.alloc(0));
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith("Dropped relay message: empty payload");
    expect(socket.sent).toHaveLength(0);
  });

  it("logs error when message is invalid JSON", async () => {
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
    socket.sent = [];

    socket.emit("message", "not valid json {");
    await flushAsync();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Error handling message/)
    );
  });

  it("handles bridge_auth_error and closes socket", async () => {
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

    socket.receiveJson({
      type: "bridge_auth_error",
      bridgeId: "bridge-1",
      error: "Invalid signature",
    });
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith(
      "Relay bridge auth failed: Invalid signature"
    );
    expect(socket.closeCalls).toBe(1);
  });

  it("ignores bridge_auth_challenge for different bridgeId", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const signAuthChallenge = jest.fn();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      signAuthChallenge,
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "bridge_auth_challenge",
      bridgeId: "other-bridge",
      challengeId: "challenge-1",
      nonce: "nonce-1",
      iat: 1000,
      exp: 1030,
      bridgeKeyId: "bridge-key-1",
      algorithm: "ed25519",
    });
    await flushAsync();

    expect(signAuthChallenge).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Ignored bridge auth challenge for different bridgeId"
    );
    expect(socket.sent).toHaveLength(0);
  });

  it("closes socket when signAuthChallenge throws", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      signAuthChallenge: async () => {
        throw new Error("signing failed");
      },
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

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to sign bridge auth challenge/)
    );
    expect(socket.closeCalls).toBe(1);
  });

  it("rejects command when verifySignedCommand throws and sends error result", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => {
        throw new Error("Invalid signature");
      },
      isRelayCommand: () => true,
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "command",
      requestId: "req-sig-fail",
      sequence: 1,
      command: "engine_connect",
      payload: {},
    });
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Rejected relay command/)
    );
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "command_result",
      requestId: "req-sig-fail",
      success: false,
      error: "Invalid signature",
    });
  });

  it("rejects unknown command and sends error result", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => undefined,
      isRelayCommand: () => false,
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "command",
      requestId: "req-unknown",
      command: "unknown_command",
      payload: {},
    });
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith(
      "Rejected unknown command: unknown_command"
    );
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "command_result",
      requestId: "req-unknown",
      success: false,
      error: "Unknown command",
    });
  });

  it("sends error result when handleCommand throws", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => undefined,
      isRelayCommand: () => true,
      handleCommand: async () => {
        throw new Error("handler crashed");
      },
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];

    socket.receiveJson({
      type: "command",
      requestId: "req-crash",
      sequence: 2,
      command: "engine_get_status",
      payload: {},
    });
    await flushAsync();

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0]).type).toBe("command_received");
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "command_result",
      requestId: "req-crash",
      success: false,
      error: "handler crashed",
    });
  });

  it("warns when sendBridgeEvent called while disconnected", async () => {
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => new FakeWebSocket(),
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    client.sendBridgeEvent({ event: "test_event", data: {} });
    expect(logger.warn).toHaveBeenCalledWith(
      "Cannot send bridge event: not connected to relay"
    );
  });

  it("logs WebSocket error and clears timers", async () => {
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
    socket.emit("error", new Error("network error"));
    await flushAsync();

    expect(logger.error).toHaveBeenCalledWith("WebSocket error: network error");
  });

  it("schedules reconnect after createWebSocket throws", async () => {
    const logger = createLogger();
    const sockets: FakeWebSocket[] = [];
    let callCount = 0;
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("WebSocket constructor failed");
        }
        const s = new FakeWebSocket();
        sockets.push(s);
        return s;
      },
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    await client.connect();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to create WebSocket connection/)
    );

    await jest.advanceTimersByTimeAsync(2000);
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(sockets.length).toBeGreaterThanOrEqual(1);
  });

  it("getLastSeen returns null when never connected", async () => {
    const client = new RelayClient("bridge-1", "ws://relay.test", createLogger(), undefined, {
      createWebSocket: () => new FakeWebSocket(),
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });
    expect(client.getLastSeen()).toBeNull();
  });

  it("getLastSeen returns date after message activity", async () => {
    const socket = new FakeWebSocket();
    const client = new RelayClient("bridge-1", "ws://relay.test", createLogger(), undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
    });

    await client.connect();
    socket.open();
    await flushAsync();
    expect(client.getLastSeen()).not.toBeNull();
  });

  it("logs disconnect with Buffer reason", async () => {
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
    socket.emit("close", 1001, Buffer.from("Going away", "utf-8"));
    expect(logger.warn).toHaveBeenCalledWith(
      "Disconnected from relay server (code: 1001, reason: Going away)"
    );
  });

  it("logs error when ws.send throws", async () => {
    const socket = new FakeWebSocket();
    const logger = createLogger();
    const client = new RelayClient("bridge-1", "ws://relay.test", logger, undefined, {
      createWebSocket: () => socket,
      getEnrollmentPublicKey: async () => {
        throw new Error("no identity");
      },
      verifySignedCommand: async () => undefined,
      isRelayCommand: () => true,
      handleCommand: async () => ({ success: true, data: {} }),
    });

    await client.connect();
    socket.open();
    await flushAsync();
    socket.sent = [];
    socket.sendThrows = true;

    socket.receiveJson({
      type: "command",
      requestId: "req-1",
      command: "engine_get_status",
      payload: {},
    });
    await flushAsync();

    expect(logger.error).toHaveBeenCalledWith("Error sending message: send failed");
  });

  it("logs unknown message type", async () => {
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
    socket.sent = [];

    socket.receiveJson({ type: "unknown_type", foo: "bar" });
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith(
      "Unknown message type: unknown_type"
    );
  });
});
