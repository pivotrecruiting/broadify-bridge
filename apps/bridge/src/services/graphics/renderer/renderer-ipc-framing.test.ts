import {
  appendIpcBuffer,
  isIpcBufferWithinLimit,
  decodeNextIpcPacket,
  encodeIpcPacket,
  MAX_IPC_HEADER_BYTES,
  MAX_IPC_PAYLOAD_BYTES,
  MAX_IPC_BUFFER_BYTES,
} from "./renderer-ipc-framing.js";

describe("renderer-ipc-framing", () => {
  describe("appendIpcBuffer", () => {
    it("concatenates current buffer with chunk", () => {
      const current = Buffer.from("abc");
      const chunk = Buffer.from("def");
      const result = appendIpcBuffer(current, chunk);
      expect(result.toString()).toBe("abcdef");
    });

    it("handles empty current buffer", () => {
      const chunk = Buffer.from("data");
      const result = appendIpcBuffer(Buffer.alloc(0), chunk);
      expect(result).toEqual(chunk);
    });
  });

  describe("isIpcBufferWithinLimit", () => {
    it("returns true for buffer within limit", () => {
      expect(isIpcBufferWithinLimit(Buffer.alloc(100))).toBe(true);
    });

    it("returns true for buffer at exact limit", () => {
      const atLimit = Buffer.alloc(MAX_IPC_BUFFER_BYTES);
      expect(isIpcBufferWithinLimit(atLimit)).toBe(true);
    });

    it("returns false for buffer exceeding limit", () => {
      const overLimit = Buffer.alloc(MAX_IPC_BUFFER_BYTES + 1);
      expect(isIpcBufferWithinLimit(overLimit)).toBe(false);
    });
  });

  describe("decodeNextIpcPacket", () => {
    it("returns incomplete when buffer has fewer than 4 bytes", () => {
      expect(decodeNextIpcPacket(Buffer.from([1, 2]))).toEqual({
        kind: "incomplete",
      });
    });

    it("returns invalid when header length exceeds limit", () => {
      const buf = Buffer.alloc(8);
      buf.writeUInt32BE(MAX_IPC_HEADER_BYTES + 1, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({
        kind: "invalid",
        reason: "header_length_exceeds_limit",
      });
    });

    it("returns invalid when header length is zero", () => {
      const buf = Buffer.alloc(8);
      buf.writeUInt32BE(0, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({
        kind: "invalid",
        reason: "header_length_exceeds_limit",
      });
    });

    it("returns incomplete when buffer shorter than 4 + headerLength", () => {
      const buf = Buffer.alloc(6);
      buf.writeUInt32BE(10, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({ kind: "incomplete" });
    });

    it("returns invalid when header is not valid JSON", () => {
      const header = Buffer.from("not json", "utf-8");
      const buf = Buffer.concat([
        Buffer.alloc(4),
        header,
      ]);
      buf.writeUInt32BE(header.length, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({
        kind: "invalid",
        reason: "invalid_header_json",
      });
    });

    it("returns invalid when bufferLength is not a number", () => {
      const header = JSON.stringify({ type: "cmd", bufferLength: "x" });
      const headerBuf = Buffer.from(header, "utf-8");
      const buf = Buffer.concat([Buffer.alloc(4), headerBuf]);
      buf.writeUInt32BE(headerBuf.length, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({
        kind: "invalid",
        reason: "invalid_buffer_length_type",
      });
    });

    it("returns invalid when payload length exceeds limit", () => {
      const header = JSON.stringify({
        type: "cmd",
        bufferLength: MAX_IPC_PAYLOAD_BYTES + 1,
      });
      const headerBuf = Buffer.from(header, "utf-8");
      const buf = Buffer.concat([Buffer.alloc(4), headerBuf]);
      buf.writeUInt32BE(headerBuf.length, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({
        kind: "invalid",
        reason: "payload_length_exceeds_limit",
      });
    });

    it("returns incomplete when buffer shorter than full packet", () => {
      const header = JSON.stringify({ type: "cmd", bufferLength: 100 });
      const headerBuf = Buffer.from(header, "utf-8");
      const buf = Buffer.concat([
        Buffer.alloc(4),
        headerBuf,
        Buffer.alloc(50),
      ]);
      buf.writeUInt32BE(headerBuf.length, 0);
      expect(decodeNextIpcPacket(buf)).toEqual({ kind: "incomplete" });
    });

    it("decodes valid packet and returns remaining buffer", () => {
      const payload = Buffer.from("payload");
      const header = { type: "ready", token: "abc", bufferLength: payload.length };
      const packed = encodeIpcPacket(header, payload);
      const decoded = decodeNextIpcPacket(packed);
      expect(decoded.kind).toBe("packet");
      if (decoded.kind === "packet") {
        expect(decoded.header).toEqual(header);
        expect(decoded.payload.toString()).toBe("payload");
        expect(decoded.remaining.length).toBe(0);
      }
    });

    it("decodes packet and leaves trailing bytes in remaining", () => {
      const header = { type: "cmd" };
      const packed = encodeIpcPacket(header);
      const withTrailing = Buffer.concat([packed, Buffer.from("extra")]);
      const decoded = decodeNextIpcPacket(withTrailing);
      expect(decoded.kind).toBe("packet");
      if (decoded.kind === "packet") {
        expect(decoded.remaining.toString()).toBe("extra");
      }
    });
  });

  describe("encodeIpcPacket", () => {
    it("encodes header-only packet", () => {
      const header = { type: "ready" };
      const result = encodeIpcPacket(header);
      expect(result.length).toBeGreaterThanOrEqual(4);
      const headerLen = result.readUInt32BE(0);
      const headerJson = result.subarray(4, 4 + headerLen).toString("utf-8");
      expect(JSON.parse(headerJson)).toEqual(header);
    });

    it("encodes header with payload", () => {
      const header = { type: "data", bufferLength: 5 };
      const payload = Buffer.from("hello");
      const result = encodeIpcPacket(header, payload);
      expect(result.readUInt32BE(0)).toBe(
        Buffer.from(JSON.stringify(header), "utf-8").length
      );
      expect(result.subarray(result.length - 5).toString()).toBe("hello");
    });

    it("throws when payload exceeds limit", () => {
      const huge = Buffer.alloc(MAX_IPC_PAYLOAD_BYTES + 1);
      expect(() => encodeIpcPacket({ type: "x" }, huge)).toThrow(
        "ipc_payload_exceeds_limit"
      );
    });

    it("throws when serialized header exceeds limit", () => {
      const bigHeader: Record<string, unknown> = {
        type: "x",
        data: "x".repeat(MAX_IPC_HEADER_BYTES),
      };
      expect(() => encodeIpcPacket(bigHeader)).toThrow(
        "ipc_header_exceeds_limit"
      );
    });
  });
});
