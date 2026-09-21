import {
  sendLocalNetworkNudge,
  triggerLocalNetworkPermissionPrompt,
} from "./local-network-prompt.js";

type SendCallbackT = (error: Error | null) => void;
type BindCallbackT = () => void;

const mockSend = jest.fn();
const mockClose = jest.fn();
const mockOnce = jest.fn();
const mockBind = jest.fn();
const mockSetMulticastInterface = jest.fn();
const mockCreateSocket = jest.fn(() => ({
  send: mockSend,
  close: mockClose,
  once: mockOnce,
  bind: mockBind,
  setMulticastInterface: mockSetMulticastInterface,
}));

jest.mock("dgram", () => ({
  createSocket: (type: string) => mockCreateSocket(type),
}));

const mockNetworkInterfaces = jest.fn();

jest.mock("os", () => ({
  networkInterfaces: () => mockNetworkInterfaces(),
}));

const mockLogAppInfo = jest.fn();
const mockLogAppWarn = jest.fn();

jest.mock("./app-logger.js", () => ({
  logAppInfo: (message: string) => mockLogAppInfo(message),
  logAppWarn: (message: string) => mockLogAppWarn(message),
}));

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  return () => {
    Object.defineProperty(process, "platform", { value: original });
  };
}

const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes call history but not implementations, so restore the
  // default socket factory (a prior test may have made it throw).
  mockCreateSocket.mockImplementation(() => ({
    send: mockSend,
    close: mockClose,
    once: mockOnce,
    bind: mockBind,
    setMulticastInterface: mockSetMulticastInterface,
  }));
  // Default: bind succeeds and send succeeds.
  mockBind.mockImplementation((_opts: unknown, cb: BindCallbackT) => cb());
  mockSend.mockImplementation(
    (
      _payload: Buffer,
      _port: number,
      _address: string,
      cb: SendCallbackT,
    ) => cb(null),
  );
  // Default: two active external interfaces plus internal loopback + IPv6.
  mockNetworkInterfaces.mockReturnValue({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en9: [{ family: "IPv4", internal: false, address: "192.168.178.30" }],
    en0: [
      { family: "IPv4", internal: false, address: "192.168.1.10" },
      { family: "IPv6", internal: false, address: "fe80::1" },
    ],
  });
});

describe("sendLocalNetworkNudge", () => {
  it("sends one mDNS query pinned to each active, non-internal IPv4 interface", async () => {
    const ok = await sendLocalNetworkNudge();

    expect(ok).toBe(true);
    // en9 + en0 IPv4 only — loopback and IPv6 excluded.
    expect(mockCreateSocket).toHaveBeenCalledTimes(2);
    const boundAddresses = mockBind.mock.calls.map(
      (call) => (call[0] as { address: string }).address,
    );
    expect(boundAddresses.sort()).toEqual(["192.168.1.10", "192.168.178.30"]);
    expect(mockSetMulticastInterface).toHaveBeenCalledWith("192.168.178.30");
    expect(mockSetMulticastInterface).toHaveBeenCalledWith("192.168.1.10");
    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const call of mockSend.mock.calls) {
      const [payload, port, address] = call as [Buffer, number, string];
      expect(port).toBe(5353);
      expect(address).toBe("224.0.0.251");
      expect(payload.readUInt16BE(4)).toBe(1);
      expect(payload.toString("ascii")).toContain("_services");
    }
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it("returns false and opens no socket when there is no active interface", async () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    });

    const ok = await sendLocalNetworkNudge();

    expect(ok).toBe(false);
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it("returns false and warns when the send fails on every interface", async () => {
    mockSend.mockImplementation(
      (
        _payload: Buffer,
        _port: number,
        _address: string,
        cb: SendCallbackT,
      ) => cb(new Error("EHOSTUNREACH")),
    );

    const ok = await sendLocalNetworkNudge();

    expect(ok).toBe(false);
    expect(mockLogAppWarn).toHaveBeenCalledWith(
      expect.stringContaining("EHOSTUNREACH"),
    );
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it("does not throw and resolves false when a socket cannot be created", async () => {
    mockCreateSocket.mockImplementation(() => {
      throw new Error("no sockets");
    });

    await expect(sendLocalNetworkNudge()).resolves.toBe(false);
    expect(mockLogAppWarn).toHaveBeenCalledWith(
      expect.stringContaining("no sockets"),
    );
  });
});

describe("triggerLocalNetworkPermissionPrompt", () => {
  it("does nothing on non-macOS platforms", () => {
    const restore = setPlatform("win32");
    try {
      triggerLocalNetworkPermissionPrompt();
      expect(mockCreateSocket).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("sends the nudge on macOS", async () => {
    const restore = setPlatform("darwin");
    try {
      triggerLocalNetworkPermissionPrompt();
      await flushAsync();

      expect(mockSend).toHaveBeenCalled();
      expect(mockLogAppInfo).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
