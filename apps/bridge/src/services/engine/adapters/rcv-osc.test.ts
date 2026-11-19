import { encodeOscMessage, decodeOscPacket } from "./rcv-osc.js";

function hex(buffer: Buffer): string {
  return buffer.toString("hex");
}

describe("encodeOscMessage", () => {
  it("encodes an int argument with big-endian payload (golden bytes)", () => {
    const encoded = encodeOscMessage("/device/scene", [3]);
    expect(hex(encoded)).toBe(
      "2f6465766963652f7363656e65000000" + // "/device/scene" + 3 null pad
        "2c690000" + // ",i" + pad
        "00000003" // int32 BE 3
    );
  });

  it("encodes a message without arguments (golden bytes)", () => {
    const encoded = encodeOscMessage("/show");
    expect(hex(encoded)).toBe(
      "2f73686f77000000" + // "/show" + 3 null pad
        "2c000000" // "," + pad
    );
  });

  it("encodes a string argument with padding (golden bytes)", () => {
    const encoded = encodeOscMessage("/show/transition", ["fade"]);
    expect(hex(encoded)).toBe(
      "2f73686f772f7472616e736974696f6e00000000" + // 16 chars + 4 null pad
        "2c730000" + // ",s" + pad
        "6661646500000000" // "fade" + 4 null pad
    );
  });

  it("encodes multiple int arguments (golden bytes)", () => {
    const encoded = encodeOscMessage("/device/button", [105, 1]);
    expect(hex(encoded)).toBe(
      "2f6465766963652f627574746f6e0000" + // "/device/button" + 2 null pad
        "2c696900" + // ",ii" + pad
        "00000069" + // 105
        "00000001" // 1
    );
  });

  it("encodes forced and fractional floats as float32", () => {
    expect(hex(encodeOscMessage("/x", [{ float: 2 }]))).toBe(
      "2f780000" + "2c660000" + "40000000"
    );
    expect(hex(encodeOscMessage("/x", [0.5]))).toBe(
      "2f780000" + "2c660000" + "3f000000"
    );
  });

  it("pads addresses that already align to four bytes", () => {
    // 7 chars + null terminator = 8: still needs its terminating null block.
    const encoded = encodeOscMessage("/abcdef", []);
    expect(hex(encoded)).toBe("2f61626364656600" + "2c000000");
  });

  it("rejects addresses without a leading slash", () => {
    expect(() => encodeOscMessage("show", [])).toThrow(/must start with/);
  });
});

describe("decodeOscPacket", () => {
  it("round-trips int and string arguments", () => {
    const encoded = encodeOscMessage("/show/pgmcurrent", ["scene", 3]);
    expect(decodeOscPacket(encoded)).toEqual([
      { address: "/show/pgmcurrent", args: ["scene", 3] },
    ]);
  });

  it("round-trips float arguments", () => {
    const encoded = encodeOscMessage("/x", [0.5]);
    const [message] = decodeOscPacket(encoded);
    expect(message.address).toBe("/x");
    expect(message.args[0]).toBeCloseTo(0.5);
  });

  it("decodes blob arguments as Buffers", () => {
    const blob = Buffer.from("<RcvShow PgmScene=\"2\"/>", "utf8");
    const address = Buffer.from("2f73686f77000000", "hex"); // "/show"
    const tags = Buffer.from("2c620000", "hex"); // ",b"
    const size = Buffer.alloc(4);
    size.writeUInt32BE(blob.length, 0);
    const padding = Buffer.alloc(((blob.length + 3) & ~0x03) - blob.length);
    const packet = Buffer.concat([address, tags, size, blob, padding]);

    const [message] = decodeOscPacket(packet);
    expect(message.address).toBe("/show");
    expect(Buffer.isBuffer(message.args[0])).toBe(true);
    expect((message.args[0] as Buffer).toString("utf8")).toContain("PgmScene");
  });

  it("flattens bundles into their messages", () => {
    const inner = encodeOscMessage("/show/record", [1]);
    const size = Buffer.alloc(4);
    size.writeInt32BE(inner.length, 0);
    const bundle = Buffer.concat([
      Buffer.from("#bundle\0", "ascii"),
      Buffer.alloc(8), // time tag
      size,
      inner,
    ]);

    expect(decodeOscPacket(bundle)).toEqual([
      { address: "/show/record", args: [1] },
    ]);
  });

  it("returns [] for malformed packets instead of throwing", () => {
    expect(decodeOscPacket(Buffer.from("garbage-no-slash"))).toEqual([]);
    expect(decodeOscPacket(Buffer.alloc(0))).toEqual([]);
    // Unknown type tag makes the offsets unreliable.
    const address = Buffer.from("2f78000000000000", "hex").subarray(0, 4);
    const tags = Buffer.from("2c7a0000", "hex"); // ",z"
    expect(decodeOscPacket(Buffer.concat([address, tags]))).toEqual([]);
  });

  it("truncated arguments yield [] instead of throwing", () => {
    const encoded = encodeOscMessage("/device/scene", [3]);
    expect(decodeOscPacket(encoded.subarray(0, encoded.length - 2))).toEqual(
      []
    );
  });
});
