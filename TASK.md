# TASK — WP6 (rc.31): stabilization package after rc.30 soak test

Base: feature/vcam-rc13 @ c911f5d6 (rc.30). Round: 0/3. Field feedback 23.08.2026 (rc.30): Teams picture ✔, backgrounds ✔, keyer good,
noise ok. New: (1) Windows camera very pixelated; (2) Windows content paging: page goes out and never comes back; (4) macOS: key or
picture gone ~1 s every few minutes; (5) SHM engages only after the DLL's 5-s poll. (Graphics stutter = separate WP7/rc.32.)
Rule: these functions must not regress again — every fix gets a test and a log line that proves it in the field.

## S1 — Windows camera resolution (capture/camera_mediafoundation.cpp, capture/camera_media_type_rank.h)
- Default `BROADIFY_MEETING_CAMERA_MAX_HEIGHT` 720 → 1080 (env still honoured; 0 = off). Keep the 30-fps clamp.
- Ranker: never select a type below the requested size when a same-fps candidate ≥ request exists; pixel floor computed against the
  UNCLAMPED program size; subtype preference (NV12 > YUY2 > MJPG) only decides among candidates ≥ request. Unit test with the three ladders
  (Logitech MJPG 1080/720 + YUY2 720p10; NV12 1080/720/540; MJPG 1080/720 + YUY2 960x540 + NV12 848x480) asserting 1080p is chosen.
- Emit `camera_native_media_type_selected` via emitHelperEvent (sidecar) with width/height/fps/subtype — not only cout.
- Docs: meeting-windows-performance.md (KF-3 note updated: capture 1080, keyer still 512; measured trade-off to be confirmed in field).

## S2 — Content page decode (compose/compositor.cpp:296-322 + callers)
- Decode off the render thread: a `MediaPageCache` (new compose/media_page_cache.{h,cpp}, platform-neutral) with a worker thread,
  LRU of 4 decoded pages keyed by path, prefetch of page±1 when `page`/`page_count`/sibling paths are known (control_server.cpp:222-241 parses
  `page`, `page_count`, `rendered_page_path`; if sibling paths are not available from the payload, derive them from the naming pattern only if
  the pattern is deterministic — otherwise prefetch nothing and say so in the doc).
- Render thread: `getMediaLayerImage` returns the previously displayed page until the new one is decoded (never blank-out on flip).
- No negative cache: a failed open/decode is retried on the next program frame with bounded backoff (250 ms → 2 s), and logged ONCE per path
  via emitHelperEvent `media_page_load_failed {path, errno/stage}` and `media_page_loaded {path, decode_ms}` on success.
- Win32 file open via UTF-16 (`_wfopen`/`std::filesystem::path` from UTF-8) so non-ASCII user profiles work; JSON string unescape for the path
  (json_utils extractStringField keeps escapes — fix or unescape at the call site, with a test `C:\\Users\\Jörg\\…`).
- Cache key for the GPU upload: monotonic generation counter instead of the `RgbaImage*` address (compositor.cpp:1280/1329, d3d11 uploadLayer).
- Tests: cache LRU/prefetch/keep-previous semantics; retry after failure; path unescape.

## S4 — macOS 1-s dropouts (pipeline/frame_pipeline.cpp Apple branch, keyer/subject_presence.h, keyer_chain.cpp)
- Retained mask: in the `__APPLE__` fused path, when `!fusedKeyerWorkDue && hasCameraFrame && keyerEnabled && previous fused mask exists`,
  composite with the previous mask (timestamp = current frame) instead of un-keyed — mirror of the Windows branch at ~:2514. Never render
  raw camera while the keyer is enabled and a prior mask exists.
- Subject presence (macOS values): `acceptAfterMs` 400 → 1500; collapse hold 12 → 45 frames; above-max-coverage → hold previous mask
  instead of pass-through. Windows values untouched.
- AVFoundation: observe `AVCaptureSessionWasInterrupted/InterruptionEnded/RuntimeError` and emit `camera_interrupted/camera_resumed`
  helper events; stall watchdog emits `camera_stalled/camera_recovered` via emitHelperEvent (not cout).
- Observability: `setMeetingDegradationStage` changes and `keyer_fallback_change` go through emitHelperEvent so they land in the sidecar log
  on macOS (`open` swallows stdout). Add `empty_valid`/`no_subject` to `keyer.get`.
- Tests: presence state machine timings (macOS vs Windows constants); retained-mask selection logic (factor into a pure function).

## S5 — DLL SHM poll (vcam-helper/windows/shm_frame_reader.cpp)
- `kMappingRetryMs` 5000 → 1000 while no mapping / zero geometry; keep 5 s for the stale/backoff case. Doc timing sentence updated (≤ ~3 s).

## Acceptance
- macOS: only S4 changes the Apple path (list every Apple-affecting hunk in the report). Windows: S1/S2/S5.
- lint/jest/build/helper build/ctest green (recorder audio_input_rejected known); Windows CI (test-release/wp6-stabilize) green.
- Field checklist (docs/bridge/features/meeting-field-checklist.md — NEW): Teams picture, background change < 2 s, page flip keeps
  previous page until new page, camera 1080p line in sidecar, SHM within 3 s, Mac: no un-keyed frames; which log lines prove each.
