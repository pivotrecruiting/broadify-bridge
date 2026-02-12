/**
 * IPC hard limits to avoid oversized payloads and memory pressure.
 */
export const MAX_IPC_HEADER_BYTES = 64 * 1024;
export const MAX_IPC_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_IPC_BUFFER_BYTES = MAX_IPC_HEADER_BYTES + MAX_IPC_PAYLOAD_BYTES + 4;

export type IpcHeaderT = {
  type: string;
  bufferLength?: number;
  token?: string;
  [key: string]: unknown;
};

export type DecodedIpcPacketT =
  | { kind: "incomplete" }
  | { kind: "invalid"; reason: string }
  | { kind: "packet"; header: IpcHeaderT; payload: Buffer; remaining: Buffer };

/**
 * Append incoming chunk to an existing IPC buffer.
 *
 * @param current Existing buffer.
 * @param chunk New incoming bytes.
 * @returns Concatenated buffer.
 */
export function appendIpcBuffer(current: Buffer, chunk: Buffer): Buffer {
  return Buffer.concat([current, chunk]);
}

/**
 * Validate that current buffered data stays within hard limits.
 *
 * @param buffer Buffered data.
 * @returns True when size is acceptable.
 */
export function isIpcBufferWithinLimit(buffer: Buffer): boolean {
  return buffer.length <= MAX_IPC_BUFFER_BYTES;
}

/**
 * Decode the next IPC packet from the provided buffer.
 *
 * @param buffer Source buffer.
 * @returns Decoded packet, invalid marker, or incomplete marker.
 */
export function decodeNextIpcPacket(buffer: Buffer): DecodedIpcPacketT {
  if (buffer.length < 4) {
    return { kind: "incomplete" };
  }

  const headerLength = buffer.readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_IPC_HEADER_BYTES) {
    return { kind: "invalid", reason: "header_length_exceeds_limit" };
  }
  if (buffer.length < 4 + headerLength) {
    return { kind: "incomplete" };
  }

  const headerRaw = buffer.subarray(4, 4 + headerLength);
  let header: IpcHeaderT;
  try {
    header = JSON.parse(headerRaw.toString("utf-8")) as IpcHeaderT;
  } catch {
    return { kind: "invalid", reason: "invalid_header_json" };
  }

  const hasBufferLength = Object.prototype.hasOwnProperty.call(
    header,
    "bufferLength",
  );
  if (hasBufferLength && typeof header.bufferLength !== "number") {
    return { kind: "invalid", reason: "invalid_buffer_length_type" };
  }
  const payloadLength = typeof header.bufferLength === "number" ? header.bufferLength : 0;
  if (payloadLength < 0 || payloadLength > MAX_IPC_PAYLOAD_BYTES) {
    return { kind: "invalid", reason: "payload_length_exceeds_limit" };
  }

  const totalLength = 4 + headerLength + payloadLength;
  if (buffer.length < totalLength) {
    return { kind: "incomplete" };
  }

  const payload = buffer.subarray(4 + headerLength, totalLength);
  const remaining = buffer.subarray(totalLength);
  return { kind: "packet", header, payload, remaining };
}

/**
 * Encode an IPC header and optional payload into one write buffer.
 *
 * @param header Message header.
 * @param payload Optional binary payload.
 * @returns Encoded packet bytes.
 */
export function encodeIpcPacket(header: Record<string, unknown>, payload?: Buffer): Buffer {
  if (payload && payload.length > MAX_IPC_PAYLOAD_BYTES) {
    throw new Error("ipc_payload_exceeds_limit");
  }

  const encodedHeader = Buffer.from(JSON.stringify(header), "utf-8");
  if (encodedHeader.length > MAX_IPC_HEADER_BYTES) {
    throw new Error("ipc_header_exceeds_limit");
  }

  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(encodedHeader.length, 0);
  if (!payload) {
    return Buffer.concat([headerLength, encodedHeader]);
  }
  return Buffer.concat([headerLength, encodedHeader, payload]);
}
