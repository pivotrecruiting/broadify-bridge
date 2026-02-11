# Graphics Realtime Refactor – FrameBus N-API API Spec

## Zweck
Definiert die JS/TS API für den FrameBus. Diese API wird von Renderer und Output-Helper genutzt.
Plattform-Status: aktuell macOS only (Windows/Linux deferred).

## Module Name
- `@broadify/framebus` (Vorschlag)

## Types (TS)
```ts
type FrameBusPixelFormat = 1 | 2 | 3; // RGBA8=1, BGRA8=2, ARGB8=3

type FrameBusHeader = {
  magic: number;
  version: number;
  flags: number;
  headerSize: number;
  width: number;
  height: number;
  fps: number;
  pixelFormat: FrameBusPixelFormat;
  frameSize: number;
  slotCount: number;
  slotStride: number;
  seq: bigint;
  lastWriteNs: bigint;
};

type FrameBusWriter = {
  name: string;
  size: number;
  header: FrameBusHeader;
  writeFrame(buffer: Buffer, timestampNs?: bigint): void;
  close(): void;
};

type FrameBusReader = {
  name: string;
  header: FrameBusHeader;
  readLatest(): { buffer: Buffer; timestampNs: bigint; seq: bigint } | null;
  close(): void;
};
```

Hinweis: Aktuell ist nur `pixelFormat = 1 (RGBA8)` erlaubt. BGRA/ARGB bleiben reserviert; BGRA ist nicht zulässig.

## API (JS)
```ts
import { createWriter, openReader } from "@broadify/framebus";

const writer = createWriter({
  name: "framebus-<uuid>",
  width: 1920,
  height: 1080,
  fps: 50,
  pixelFormat: 1,
  slotCount: 2,
});

writer.writeFrame(rgbaBuffer, process.hrtime.bigint());
writer.close();

const reader = openReader({ name: "framebus-<uuid>" });
const frame = reader.readLatest();
reader.close();
```

## Functions
- `createWriter({ name, width, height, fps, pixelFormat, slotCount }) -> FrameBusWriter`
- `openReader({ name }) -> FrameBusReader`

## Errors
- `InvalidHeaderError` bei Header-Mismatch.
- `FrameSizeError` bei falscher Buffer-Größe.
- `OpenError` bei fehlendem Shared Memory Segment.

## Finalisiert
- Fehlerklassen: `InvalidHeaderError`, `FrameSizeError`, `OpenError`.
- Performance-Tests: 1080p@50 (60s), Throughput + Latenz messen, Drops ≤ 1%.
- Cleanup: Writer `close()` unlinkt Shared-Memory Segment; Reader `close()` unmappt nur.
