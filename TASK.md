# TASK — HF1 (v0.25.2 hotfix + rc line): restore BFRG v1 for legacy VCam clients; tolerant camera-select schema

Base: feature/vcam-rc13 @ 17132d34 (rc.32). Round: 0/3. PRODUCTION bugs on macOS v0.25.1; fixes must be minimal and surgical.

## Bug 1 — Mac Teams black picture (root cause, verified in field + code)
Commit f7baffa0 (bfrg v2, 22.08.) made `raw_frame_server.cpp` write 40-byte v2 records (`writeBfrgHeaderV2`) to EVERY TCP client. The macOS
CMIO extension (`BroadifyVCamExtension/RawFrameStreamReader.swift:13-17,211-220` — v1-only, headerSize 32, hard-rejects version != 1)
disconnects on the first record and loops reconnects → Teams shows the splash. Only the Windows DLL was taught v1/v2. The extension
advertises nothing; the Windows DLL sends `X-Broadify-Accepts: keepalive-v2` (server sniff exists at raw_frame_server.cpp:384-386).

### Fix HF1-1 (server, meeting-helper)
- In `apps/bridge/native/meeting-helper/src/preview/raw_frame_server.cpp`: per-client protocol version derived from the existing
  `X-Broadify-Accepts` sniff — clients advertising `keepalive-v2` get v2 records + zero-length keep-alives (unchanged, Windows DLL);
  clients WITHOUT it get BFRG **v1** 32-byte records (exact pre-f7baffa0 layout — verify against `git show v0.23.5:...raw_frame_server.cpp`
  writeRawFramePayload) and NO zero-length keep-alives (heartbeat via full-frame resend as before). `captureNs` dropped for v1 clients.
- ctest: raw_frame_server (or a pure record-writer helper) — v1 client handshake → first record has version 1 + headerSize 32 and
  byte-layout equal to the v0.23.5 writer for the same frame; v2 client → version 2 + 40 bytes; keep-alives only for v2.
- Do NOT touch the Swift extension in this hotfix (its v2 upgrade + activation-flow fix is a separate follow-up WP).

## Bug 2 — "Invalid payload for meeting_camera_select" (webapp builder page broken since rc.28)
Commit da6405e3 made `MeetingCameraSelectionSchema` `.strict()` with only `camera_index`/`stable_key`; the webapp builder sends additionally
`width`, `height`, `fps`, `selection_source`, `lock_mode` (meeting-builder-camera.ts:27-35, unchanged since June) → strict reject in
`parseRelayPayload` → builder camera select AND "Start Live Test" (meeting_camera_start) broken against bridge ≥ rc.28.

### Fix HF1-2 (bridge TS)
- `apps/bridge/src/services/meeting/meeting-command-schemas.ts`: keep `camera_index` (int ≥0) and `stable_key` (1..1024) typed, additionally
  type the known webapp fields (`width`/`height`/`fps` bounded ints, `selection_source`/`lock_mode` bounded strings) as optional, and replace
  `.strict()` with `.passthrough()` so future additive webapp fields never brick production again. Applies to both meeting_camera_select and
  meeting_camera_start.
- jest: a test that feeds the EXACT real webapp builder payload (`{camera_index, stable_key, width:1920, height:1080, fps:30,
  selection_source:"user", lock_mode:"manual_index"}`) through the relay parse path for both commands and asserts acceptance; plus the
  connections-page payload `{camera_index: 2}`; plus a rejection case (camera_index: -1).

## Parity / must NOT change
- Windows DLL path byte-identical (v2 + keep-alive negotiation as today). Preview/MJPEG paths untouched. macOS helper otherwise untouched.
- No other schema changes; no helper protocol version bump.

## Acceptance
- lint/jest/build/helper build/ctest green (recorder audio_input_rejected known); CI Mac+Win green (test-release/hf1-vcam-v1).
- Field (Mac v0.25.1-Extension v17 gegen neuen Helper): Teams zeigt Bild; `lsof -nP -iTCP:18787` zeigt ESTABLISHED während Teams streamt.
- Field (Builder-Seite): Kamera-Wechsel + Live-Test ohne "Invalid payload".
