/**
 * TCP framing for the RØDECaster Video OSC transport.
 *
 * Each OSC packet on the wire is prefixed with a 4-byte little-endian int32
 * byte count (the OSC payload itself stays big-endian per spec). The splitter
 * mirrors the device's tolerant behaviour: a non-positive length prefix is
 * skipped to resync instead of stalling the stream.
 */

/** Upper bound for a single frame; anything larger is a protocol violation. */
export const RCV_MAX_FRAME_BYTES = 1024 * 1024;

/** Prefix an OSC payload with its 4-byte little-endian length. */
export function frameRcvPacket(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

/**
 * Incremental frame splitter for the RCV TCP stream. Feed raw socket chunks
 * in via push(); complete OSC payloads (without the length prefix) come back
 * in order. Partial frames are buffered until the rest arrives.
 */
export class RcvFrameSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number = RCV_MAX_FRAME_BYTES) {}

  /**
   * @throws RangeError when a frame announces more than maxFrameBytes —
   *         the stream is then unrecoverable and the caller should drop
   *         the connection.
   */
  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;

    const frames: Buffer[] = [];

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readInt32LE(0);

      if (frameLength <= 0) {
        // Resync: drop the invalid prefix instead of stalling forever.
        this.buffer = this.buffer.subarray(4);
        continue;
      }

      if (frameLength > this.maxFrameBytes) {
        this.reset();
        throw new RangeError(
          `RCV frame of ${frameLength} bytes exceeds the ${this.maxFrameBytes} byte limit`
        );
      }

      if (this.buffer.length < frameLength + 4) {
        break;
      }

      frames.push(Buffer.from(this.buffer.subarray(4, 4 + frameLength)));
      this.buffer = this.buffer.subarray(4 + frameLength);
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
