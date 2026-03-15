import { EventEmitter } from "events";
import { AtemAdapter } from "./atem-adapter.js";

const mockAtemConnect = jest.fn();
const mockAtemDisconnect = jest.fn();

jest.mock("atem-connection", () => {
  return {
    Atem: jest.fn().mockImplementation(() => {
      const emitter = new EventEmitter();
      return {
        connect: (ip: string, port: number) => {
          mockAtemConnect(ip, port);
          setImmediate(() => emitter.emit("connected"));
        },
        disconnect: mockAtemDisconnect,
        on: emitter.on.bind(emitter),
        once: emitter.once.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
      };
    }),
  };
});

describe("AtemAdapter", () => {
  let adapter: AtemAdapter;

  beforeEach(() => {
    adapter = new AtemAdapter();
    mockAtemConnect.mockClear();
    mockAtemDisconnect.mockClear();
  });

  describe("connect", () => {
    it("throws when config type is not atem", async () => {
      await expect(
        adapter.connect({ type: "vmix", ip: "10.0.0.1", port: 9910 })
      ).rejects.toThrow('AtemAdapter only supports type "atem"');
    });

    it("throws when already connected", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await expect(
        adapter.connect({ type: "atem", ip: "10.0.0.2", port: 9910 })
      ).rejects.toThrow("already connected");
    });

    it("connects successfully and calls Atem.connect", async () => {
      await adapter.connect({ type: "atem", ip: "192.168.1.100", port: 9910 });
      expect(mockAtemConnect).toHaveBeenCalledWith("192.168.1.100", 9910);
      expect(adapter.getStatus()).toBe("connected");
    });
  });

  describe("disconnect", () => {
    it("resets state and calls Atem.disconnect", async () => {
      await adapter.connect({ type: "atem", ip: "10.0.0.1", port: 9910 });
      await adapter.disconnect();
      expect(mockAtemDisconnect).toHaveBeenCalled();
      expect(adapter.getStatus()).toBe("disconnected");
    });
  });

  describe("getStatus", () => {
    it("returns disconnected initially", () => {
      expect(adapter.getStatus()).toBe("disconnected");
    });
  });
});
