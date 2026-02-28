import { WebSocket } from "ws";
import { RelayClient } from "./relay-client.js";

class FakeWebSocket {
  public readyState = WebSocket.CONNECTING;
  public sent: string[] = [];
  public closeCalls = 0;
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

  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
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
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "bridge_hello",
      bridgeId: "bridge-1",
      version: "1.2.3",
      bridgeName: "Studio A",
      auth: {
        bridgeKeyId: "bridge-key-1",
        algorithm: "ed25519",
      },
    });
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
});
