import { triggerLocalNetworkPermissionPrompt } from "./local-network-prompt.js";

type SendCallbackT = (error: Error | null) => void;

const mockSend = jest.fn();
const mockClose = jest.fn();
const mockOnce = jest.fn();
const mockCreateSocket = jest.fn(() => ({
  send: mockSend,
  close: mockClose,
  once: mockOnce,
}));

jest.mock("dgram", () => ({
  createSocket: (type: string) => mockCreateSocket(type),
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

describe("triggerLocalNetworkPermissionPrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does nothing on non-macOS platforms", () => {
    const restore = setPlatform("win32");
    try {
      triggerLocalNetworkPermissionPrompt();
      expect(mockCreateSocket).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("sends one mDNS query to 224.0.0.251:5353 and closes the socket", () => {
    const restore = setPlatform("darwin");
    try {
      triggerLocalNetworkPermissionPrompt();

      expect(mockCreateSocket).toHaveBeenCalledWith("udp4");
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [payload, port, address, callback] = mockSend.mock.calls[0] as [
        Buffer,
        number,
        string,
        SendCallbackT,
      ];
      expect(port).toBe(5353);
      expect(address).toBe("224.0.0.251");
      // DNS wire format: standard query with exactly one question for the
      // DNS-SD service enumeration name.
      expect(payload.readUInt16BE(4)).toBe(1);
      expect(payload.toString("ascii")).toContain("_services");

      callback(null);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockLogAppInfo).toHaveBeenCalled();
      expect(mockLogAppWarn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("logs a warning and still closes the socket when the send fails", () => {
    const restore = setPlatform("darwin");
    try {
      triggerLocalNetworkPermissionPrompt();

      const callback = mockSend.mock.calls[0][3] as SendCallbackT;
      callback(new Error("network down"));

      expect(mockLogAppWarn).toHaveBeenCalledWith(
        expect.stringContaining("network down"),
      );
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("logs a warning when the socket cannot be created", () => {
    const restore = setPlatform("darwin");
    try {
      mockCreateSocket.mockImplementationOnce(() => {
        throw new Error("no sockets");
      });

      expect(() => triggerLocalNetworkPermissionPrompt()).not.toThrow();
      expect(mockLogAppWarn).toHaveBeenCalledWith(
        expect.stringContaining("no sockets"),
      );
    } finally {
      restore();
    }
  });
});
