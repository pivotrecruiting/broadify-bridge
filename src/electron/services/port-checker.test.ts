import { EventEmitter } from "events";
import {
  isPortAvailable,
  findAvailablePort,
  checkPortsAvailability,
} from "./port-checker.js";

type MockServer = EventEmitter & {
  listen: jest.Mock;
  close: jest.Mock;
  removeAllListeners: jest.Mock;
};

function makeMockServer(): MockServer {
  const emitter = new EventEmitter() as MockServer;
  emitter.listen = jest.fn();
  emitter.close = jest.fn(function (this: MockServer, cb?: () => void) {
    setImmediate(() => {
      this.emit("close");
      cb?.();
    });
  });
  emitter.removeAllListeners = jest.fn();
  return emitter;
}

const mockCreateServer = jest.fn();
jest.mock("net", () => ({
  createServer: () => mockCreateServer(),
}));

describe("port-checker", () => {
  afterEach(() => {
    mockCreateServer.mockReset();
    jest.useRealTimers();
  });

  describe("isPortAvailable", () => {
    it("resolves true when server emits listening and then close", async () => {
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen.mockImplementation(() => {
          setImmediate(() => s.emit("listening"));
        });
        return s;
      });

      const result = await isPortAvailable(9999, "0.0.0.0");
      expect(result).toBe(true);
    });

    it("resolves false when server emits EADDRINUSE", async () => {
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen.mockImplementation(() => {
          setImmediate(() =>
            s.emit("error", { code: "EADDRINUSE" } as NodeJS.ErrnoException)
          );
        });
        return s;
      });

      const result = await isPortAvailable(9999);
      expect(result).toBe(false);
    });

    it("resolves false after timeout when server never emits", async () => {
      jest.useFakeTimers();
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen.mockImplementation(() => {});
        return s;
      });

      const promise = isPortAvailable(9999);
      jest.advanceTimersByTime(2000);
      await expect(promise).resolves.toBe(false);
    });
  });

  describe("findAvailablePort", () => {
    it("returns first port when it is available", async () => {
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen.mockImplementation(() => {
          setImmediate(() => s.emit("listening"));
        });
        return s;
      });

      const port = await findAvailablePort(19000, 19005, "0.0.0.0");
      expect(port).toBe(19000);
    });

    it("returns null when no port in range is available", async () => {
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen.mockImplementation(() => {
          setImmediate(() =>
            s.emit("error", { code: "EADDRINUSE" } as NodeJS.ErrnoException)
          );
        });
        return s;
      });

      const port = await findAvailablePort(19000, 19002, "0.0.0.0");
      expect(port).toBeNull();
    });

    it("uses startPort + 100 as max when maxPort not given", async () => {
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen.mockImplementation(() => {
          setImmediate(() =>
            s.emit("error", { code: "EADDRINUSE" } as NodeJS.ErrnoException)
          );
        });
        return s;
      });

      const port = await findAvailablePort(20000);
      expect(port).toBeNull();
    });
  });

  describe("checkPortsAvailability", () => {
    it("returns map of port to availability", async () => {
      mockCreateServer.mockImplementation(() => {
        const s = makeMockServer();
        s.listen = jest.fn((port: number) => {
          setImmediate(() => {
            if (port === 18001) s.emit("listening");
            else
              s.emit("error", {
                code: "EADDRINUSE",
              } as NodeJS.ErrnoException);
          });
        });
        return s;
      });

      const result = await checkPortsAvailability([18001, 18002], "0.0.0.0");
      expect(result.get(18001)).toBe(true);
      expect(result.get(18002)).toBe(false);
    });
  });
});
