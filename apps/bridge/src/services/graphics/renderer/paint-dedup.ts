export type ShouldSkipIdenticalPaintInputT = {
  buffer: Buffer;
  lastWritten: Buffer | null;
  nowMs: number;
  lastWrittenAtMs: number;
  windowMs: number;
};

export function shouldSkipIdenticalPaint({
  buffer,
  lastWritten,
  nowMs,
  lastWrittenAtMs,
  windowMs,
}: ShouldSkipIdenticalPaintInputT): boolean {
  return (
    lastWritten !== null &&
    nowMs - lastWrittenAtMs < windowMs &&
    buffer.equals(lastWritten)
  );
}
