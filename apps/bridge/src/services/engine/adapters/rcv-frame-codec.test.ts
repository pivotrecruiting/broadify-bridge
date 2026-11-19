import { frameRcvPacket, RcvFrameSplitter } from "./rcv-frame-codec.js";

describe("frameRcvPacket", () => {
  it("prefixes the payload with a little-endian length", () => {
    const framed = frameRcvPacket(Buffer.from("abcd"));
    expect(framed.toString("hex")).toBe("04000000" + "61626364");
  });
});

describe("RcvFrameSplitter", () => {
  it("extracts a single frame delivered in one chunk", () => {
    const splitter = new RcvFrameSplitter();
    const frames = splitter.push(frameRcvPacket(Buffer.from("hello")));
    expect(frames.map((f) => f.toString())).toEqual(["hello"]);
  });

  it("extracts two frames delivered in one chunk", () => {
    const splitter = new RcvFrameSplitter();
    const chunk = Buffer.concat([
      frameRcvPacket(Buffer.from("one")),
      frameRcvPacket(Buffer.from("two")),
    ]);
    expect(splitter.push(chunk).map((f) => f.toString())).toEqual([
      "one",
      "two",
    ]);
  });

  it("reassembles a frame split across chunks, including a split prefix", () => {
    const splitter = new RcvFrameSplitter();
    const framed = frameRcvPacket(Buffer.from("payload"));

    expect(splitter.push(framed.subarray(0, 2))).toEqual([]); // half prefix
    expect(splitter.push(framed.subarray(2, 6))).toEqual([]); // rest + start
    const frames = splitter.push(framed.subarray(6));
    expect(frames.map((f) => f.toString())).toEqual(["payload"]);
  });

  it("resyncs past non-positive length prefixes", () => {
    const splitter = new RcvFrameSplitter();
    const zeroPrefix = Buffer.alloc(4); // length 0 → skipped
    const frames = splitter.push(
      Buffer.concat([zeroPrefix, frameRcvPacket(Buffer.from("ok"))])
    );
    expect(frames.map((f) => f.toString())).toEqual(["ok"]);
  });

  it("throws on frames exceeding the size limit and resets", () => {
    const splitter = new RcvFrameSplitter(16);
    const prefix = Buffer.alloc(4);
    prefix.writeInt32LE(1024, 0);

    expect(() => splitter.push(prefix)).toThrow(RangeError);
    // After the reset the splitter accepts fresh frames again.
    const frames = splitter.push(frameRcvPacket(Buffer.from("ok")));
    expect(frames.map((f) => f.toString())).toEqual(["ok"]);
  });

  it("buffers partial frames until the rest arrives", () => {
    const splitter = new RcvFrameSplitter();
    const framed = frameRcvPacket(Buffer.from("abcdef"));
    expect(splitter.push(framed.subarray(0, 8))).toEqual([]);
    expect(splitter.push(framed.subarray(8)).map((f) => f.toString())).toEqual([
      "abcdef",
    ]);
  });
});
