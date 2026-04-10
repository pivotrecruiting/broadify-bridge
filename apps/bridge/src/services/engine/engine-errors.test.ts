import {
  EngineError,
  EngineErrorCode,
  createConnectionTimeoutError,
  createConnectionRefusedError,
  createNetworkError,
  createDeviceUnreachableError,
  createAlreadyConnectedError,
  createAlreadyConnectingError,
  createNotConnectedError,
} from "./engine-errors.js";

describe("engine-errors", () => {
  describe("EngineError", () => {
    it("creates error with code and message", () => {
      const err = new EngineError(
        EngineErrorCode.CONNECTION_TIMEOUT,
        "test message"
      );
      expect(err.name).toBe("EngineError");
      expect(err.code).toBe(EngineErrorCode.CONNECTION_TIMEOUT);
      expect(err.message).toBe("test message");
    });

    it("includes details when provided", () => {
      const err = new EngineError(
        EngineErrorCode.INVALID_IP,
        "bad ip",
        { ip: "x" }
      );
      expect(err.details).toEqual({ ip: "x" });
    });

    it("toJSON returns serializable object", () => {
      const err = new EngineError(
        EngineErrorCode.NETWORK_ERROR,
        "network down",
        { ip: "10.0.0.1" }
      );
      expect(err.toJSON()).toEqual({
        code: EngineErrorCode.NETWORK_ERROR,
        message: "network down",
        details: { ip: "10.0.0.1" },
      });
    });
  });

  describe("createConnectionTimeoutError", () => {
    it("returns error with ip, port, timeoutMs in details", () => {
      const err = createConnectionTimeoutError("192.168.1.1", 9910, 5000);
      expect(err.code).toBe(EngineErrorCode.CONNECTION_TIMEOUT);
      expect(err.details).toEqual({ ip: "192.168.1.1", port: 9910, timeoutMs: 5000 });
      expect(err.message).toContain("192.168.1.1");
      expect(err.message).toContain("9910");
    });
  });

  describe("createConnectionRefusedError", () => {
    it("returns error with ip and port", () => {
      const err = createConnectionRefusedError("10.0.0.5", 8080);
      expect(err.code).toBe(EngineErrorCode.CONNECTION_REFUSED);
      expect(err.details).toEqual({ ip: "10.0.0.5", port: 8080 });
    });
  });

  describe("createNetworkError", () => {
    it("returns error with originalError in details when provided", () => {
      const err = createNetworkError("10.0.0.1", 80, new Error("ECONNREFUSED"));
      expect(err.code).toBe(EngineErrorCode.NETWORK_ERROR);
      expect(err.details?.originalError).toBe("ECONNREFUSED");
    });
  });

  describe("createDeviceUnreachableError", () => {
    it("returns error with ip and port", () => {
      const err = createDeviceUnreachableError("192.168.0.1", 9910);
      expect(err.code).toBe(EngineErrorCode.DEVICE_UNREACHABLE);
    });
  });

  describe("createAlreadyConnectedError", () => {
    it("returns error with ALREADY_CONNECTED code", () => {
      const err = createAlreadyConnectedError();
      expect(err.code).toBe(EngineErrorCode.ALREADY_CONNECTED);
    });
  });

  describe("createAlreadyConnectingError", () => {
    it("returns error with ALREADY_CONNECTING code", () => {
      const err = createAlreadyConnectingError();
      expect(err.code).toBe(EngineErrorCode.ALREADY_CONNECTING);
    });
  });

  describe("createNotConnectedError", () => {
    it("returns error with operation in details", () => {
      const err = createNotConnectedError("runMacro");
      expect(err.code).toBe(EngineErrorCode.NOT_CONNECTED);
      expect(err.details?.operation).toBe("runMacro");
      expect(err.message).toContain("runMacro");
    });
  });
});
