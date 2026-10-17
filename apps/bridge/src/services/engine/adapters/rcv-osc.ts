/**
 * Minimal OSC 1.0 codec for the RØDECaster Video (RCV) control protocol.
 *
 * The device speaks plain OSC messages over TCP (framing lives in
 * rcv-frame-codec.ts). Only the argument types the RCV actually uses are
 * supported: int32 ("i"), float32 ("f"), string ("s") and blob ("b").
 * Argument payloads are big-endian per the OSC spec; only the TCP length
 * prefix (not handled here) is little-endian.
 *
 * Decoding is deliberately tolerant: malformed packets or unknown type tags
 * yield an empty result instead of throwing, so a single odd message from
 * the device can never take the connection down.
 */

export type OscArgumentT = number | string | Buffer;

export type OscMessageT = {
  address: string;
  args: OscArgumentT[];
};

/** Wrapper to force float32 encoding for integral numbers. */
export type OscFloatT = { float: number };

export type OscEncodableArgT = number | string | OscFloatT;

const BUNDLE_HEADER = "#bundle";

function paddedLength(length: number): number {
  return (length + 4) & ~0x03;
}

function writePaddedString(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  const padded = Buffer.alloc(paddedLength(raw.length));
  raw.copy(padded, 0);
  return padded;
}

/**
 * Encode a single OSC message. Integral numbers become int32, fractional
 * numbers and OscFloatT become float32, strings become "s" arguments.
 */
export function encodeOscMessage(
  address: string,
  args: ReadonlyArray<OscEncodableArgT> = []
): Buffer {
  if (!address.startsWith("/")) {
    throw new Error(`OSC address must start with "/": ${address}`);
  }

  let typeTags = ",";
  const argBuffers: Buffer[] = [];

  for (const arg of args) {
    if (typeof arg === "string") {
      typeTags += "s";
      argBuffers.push(writePaddedString(arg));
    } else if (typeof arg === "number") {
      if (Number.isInteger(arg)) {
        typeTags += "i";
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(arg, 0);
        argBuffers.push(buf);
      } else {
        typeTags += "f";
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(arg, 0);
        argBuffers.push(buf);
      }
    } else {
      typeTags += "f";
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(arg.float, 0);
      argBuffers.push(buf);
    }
  }

  return Buffer.concat([
    writePaddedString(address),
    writePaddedString(typeTags),
    ...argBuffers,
  ]);
}

type StringReadResultT = { value: string; nextOffset: number } | null;

function readPaddedString(payload: Buffer, offset: number): StringReadResultT {
  const end = payload.indexOf(0, offset);
  if (end === -1) {
    return null;
  }
  const value = payload.toString("utf8", offset, end);
  const nextOffset = offset + paddedLength(end - offset);
  if (nextOffset > payload.length) {
    return null;
  }
  return { value, nextOffset };
}

function decodeSingleMessage(payload: Buffer): OscMessageT | null {
  const addressRead = readPaddedString(payload, 0);
  if (!addressRead || !addressRead.value.startsWith("/")) {
    return null;
  }

  const tagRead = readPaddedString(payload, addressRead.nextOffset);
  if (!tagRead || !tagRead.value.startsWith(",")) {
    // A message without a type tag string carries no arguments we care about.
    return { address: addressRead.value, args: [] };
  }

  const args: OscArgumentT[] = [];
  let offset = tagRead.nextOffset;

  for (const tag of tagRead.value.slice(1)) {
    switch (tag) {
      case "i": {
        if (offset + 4 > payload.length) return null;
        args.push(payload.readInt32BE(offset));
        offset += 4;
        break;
      }
      case "f": {
        if (offset + 4 > payload.length) return null;
        args.push(payload.readFloatBE(offset));
        offset += 4;
        break;
      }
      case "s": {
        const read = readPaddedString(payload, offset);
        if (!read) return null;
        args.push(read.value);
        offset = read.nextOffset;
        break;
      }
      case "b": {
        if (offset + 4 > payload.length) return null;
        const size = payload.readUInt32BE(offset);
        offset += 4;
        if (offset + size > payload.length) return null;
        args.push(Buffer.from(payload.subarray(offset, offset + size)));
        // Blobs pad to a 4-byte boundary without a terminator.
        offset += (size + 3) & ~0x03;
        break;
      }
      case "T":
        args.push(1);
        break;
      case "F":
        args.push(0);
        break;
      case "N":
        break;
      default:
        // Unknown tag: the remaining offsets are unreliable, drop the packet.
        return null;
    }
  }

  return { address: addressRead.value, args };
}

/**
 * Decode one OSC packet (message or bundle) into a flat list of messages.
 * Bundles are flattened recursively; malformed content yields [].
 */
export function decodeOscPacket(payload: Buffer): OscMessageT[] {
  if (payload.length < 4) {
    return [];
  }

  if (payload.toString("ascii", 0, BUNDLE_HEADER.length) === BUNDLE_HEADER) {
    const messages: OscMessageT[] = [];
    // "#bundle\0" (8 bytes) + 8-byte time tag, then size-prefixed elements.
    let offset = 16;
    while (offset + 4 <= payload.length) {
      const size = payload.readInt32BE(offset);
      offset += 4;
      if (size <= 0 || offset + size > payload.length) {
        break;
      }
      messages.push(...decodeOscPacket(payload.subarray(offset, offset + size)));
      offset += size;
    }
    return messages;
  }

  const message = decodeSingleMessage(payload);
  return message ? [message] : [];
}
