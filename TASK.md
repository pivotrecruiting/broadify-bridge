# Task: Meeting-Aufnahme mit 0,35 bit/px, BT.709-Tags und konstanter Frame-Rate (macOS + Windows) (PR C)

## Raw request
Gabriel (Product Owner, 1.10.2026): Aufnahmen aus dem Meeting Mode sehen matschig aus. Befund: H.264 mit 0,2 bit/px (≈12,4 Mbit/s bei 1080p30), keine Farbraum-Tags, PTS = Host-Clock → reale Dateien laufen mit ~26 fps VFR. Entscheidung PO: H.264 bleibt, ca. 0,35 bit/px (~10 GB/h akzeptiert), BT.709-Tags, konstante Frame-Rate.

## Context
- Customer / project: Broadify Bridge, Meeting-Helper Recorder (`apps/bridge/native/meeting-helper/src/recorder/`)
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/meeting-recorder-quality, feature/meeting-recorder-quality
- Base branch: dev (573454e5)
- Beide Plattformen: macOS (AVAssetWriter, `.mm`) und Windows (Media Foundation, `.cpp`). Windows kann lokal nicht kompiliert werden (nur Code-Review + CI); macOS wird lokal gebaut und per ctest geprüft.

## Plan
Siehe /Users/gabrielbaeuerle/.claude/plans/okay-dann-mache-bitte-linear-sunset.md, Abschnitt "WS3 (PR C)". Kurzfassung:

1. Neu `apps/bridge/native/meeting-helper/src/recorder/recorder_encode_policy.h` (header-only, plattformfrei, `constexpr`/inline, Namespace `broadify::meeting`):
   - `kRecorderBitsPerPixel = 0.35`, `kRecorderMinBitrateBps = 2'000'000`, `kRecorderMaxBitrateBps = 40'000'000`.
   - `uint64_t recorderVideoBitrateBps(uint32_t width, uint32_t height, uint32_t fps)` (fps 0 → 30), `uint32_t recorderKeyframeInterval(uint32_t fps)` = fps*2.
   - `class RecorderFrameClock { explicit RecorderFrameClock(uint32_t fps); struct Plan { uint64_t firstIndex; uint32_t count; bool discontinuity; }; Plan plan(uint64_t elapsedNs) const; void commit(uint32_t written); }`: `target = round(elapsedNs * fps / 1e9)`; `target < nextIndex` → `count 0`; sonst `gap = target - nextIndex + 1`, `count = min(gap, 4)`, `firstIndex = nextIndex`; Lücke > 1 s (`gap > fps`) → `discontinuity = true`, `firstIndex = target`, `count = 1`. `commit(written)` setzt `nextIndex = firstIndex + written` (nur für geschriebene Frames; nicht geschriebene Slots füllt der nächste Aufruf). Kurzer englischer Header-Kommentar mit der Semantik.
2. macOS `recorder_writer_factory.mm` (Z. 39-57): Bitrate aus der Policy (Formel + Clamp entfernen); Compression-Properties zusätzlich `AVVideoExpectedSourceFrameRateKey: fps`, `AVVideoAllowFrameReorderingKey: @NO`, `AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC`, `AVVideoMaxKeyFrameIntervalKey: recorderKeyframeInterval(fps)`; `AVVideoColorPropertiesKey: @{ AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2 }` in `videoSettings`. Kommentar in `recorder_writer_factory.h:27-30` ergänzen.
3. macOS `meeting_recorder.mm`: `Impl` + `RecorderFrameClock frameClock{30}`, Zähler `duplicatedFrames`, `droppedFrames` (intern, `RecordingStatus`-Shape NICHT ändern). `start` initialisiert `frameClock = RecorderFrameClock(safeFps)`. `appendVideoFrame`: `elapsedNs` aus `CMTimeSubtract(CMClockGetTime(host), sessionStart)`; Pool-Buffer wie heute füllen, danach `CVBufferSetAttachment` mit `kCVImageBufferColorPrimariesKey/TransferFunctionKey/YCbCrMatrixKey` = `..._ITU_R_709_2`; `plan = frameClock.plan(elapsedNs)`; Schleife `i < plan.count`: `if (!videoInput.isReadyForMoreMediaData) break;` → PTS `CMTimeAdd(sessionStart, CMTimeMake(plan.firstIndex + i, fps))` → `appendPixelBuffer`; danach `frameClock.commit(written)`; `videoFrames += written`. Env `BROADIFY_MEETING_RECORDER_CFR=0` (gelesen beim `start`) → heutiges Host-Clock-PTS ohne Fill. Drops/Discontinuities einmal pro Aufnahme über `logRecorderEvent` sichtbar machen (kein Log-Spam).
4. Windows `meeting_recorder_mediafoundation.cpp`: Bitrate aus Policy (Z. 486-495); Output-Type (Z. 497-506) + `MF_MT_VIDEO_NOMINAL_RANGE = MFNominalRange_16_235`, `MF_MT_YUV_MATRIX = MFVideoTransferMatrix_BT709`, `MF_MT_TRANSFER_FUNCTION = MFVideoTransFunc_709`, `MF_MT_VIDEO_PRIMARIES = MFVideoPrimaries_BT709`; Input-Type (Z. 514-523) + `MF_MT_VIDEO_NOMINAL_RANGE = MFNominalRange_0_255`; nach `SetInputMediaType` best-effort `ICodecAPI` über `writer->GetServiceForStream(videoStream, GUID_NULL, IID_PPV_ARGS(&codecApi))`: `CODECAPI_AVEncMPVGOPSize = fps*2`, `CODECAPI_AVEncMPVDefaultBPictureCount = 0` (Fehler nur loggen). `Impl` + Clock; Video-PTS (Z. 655-657): pro Index ein `IMFSample` mit demselben `IMFMediaBuffer`, `SetSampleTime(MFllMulDiv(index, 10000000, fps, 0))`, `SetSampleDuration(MFllMulDiv(1, 10000000, fps, 0))`; `WriteSample`-Fehler → nicht committen. Gleicher CFR-Kill-Switch. fMP4-Container bleibt.
5. Allowlist `apps/bridge/src/services/meeting/meeting-helper-manager.ts` (`MEETING_HELPER_FORWARDED_ENV_KEYS`, Z. 74-114): `BROADIFY_MEETING_RECORDER_CFR` ergänzen; Test `meeting-helper-manager.test.ts` (Z. 177-215) erweitern.
6. Tests:
   - Neu `apps/bridge/native/meeting-helper/tests/recorder_encode_policy_test.cpp` (plattformfrei, in `CMakeLists.txt` nach dem Muster `guided_work_size_test` Z. 305-308 als `add_executable` + in die `foreach(helper_test …)`-Liste Z. 484 ff. aufnehmen): 1080p30 → 21,0–22,5 Mbit; 720p30 ≈ 9,7 Mbit; 4K30 → 40 Mbit (Clamp); 160x90 → 2 Mbit (Clamp); Keyframe 30 → 60; Clock: On-Grid-Ticks → je count 1; 3-Frame-Lücke → 3; 6-Frame-Lücke → 4 dann 2; 1,5-s-Lücke → discontinuity + 1; früher Tick → 0; nicht committete Slots füllt der nächste Plan.
   - `tests/meeting_recorder_writer_test.mm` (nur APPLE): nach `makeRecorderWriter` `videoInput.outputSettings` prüfen (Bitrate == Policy, `AVVideoColorPropertiesKey` vorhanden, `AVVideoAllowFrameReorderingKey` NO); Frame-Schleife über die Clock treiben; nach `finishWriting` per `AVAsset` `nominalFrameRate == 30 ± 0.05` prüfen (Color-Extension-Check optional).
   - Jest/Zod unverändert (kein neues Payload-Feld).
7. Doku `docs/bridge/features/meeting-recording.md`: neuer Abschnitt "Encoding" (H.264 High, 0,35 bpp, Clamp 2–40 Mbit/s, CFR-Gitter + Fill-Regeln, BT.709-Tags, ffprobe-Prüfzeile, ~10 GB/h, Env `BROADIFY_MEETING_RECORDER_CFR`) + Windows-Dateilebenszyklus (fMP4).

Konventionen: Code-Kommentare Englisch; keine Secrets; keine Änderungen außerhalb der genannten Dateien; `npm run build:meeting-helper && npm run test:meeting-helper-native` wird vom Verifier ausgeführt, du darfst `cmake`/ctest für die neuen Tests lokal laufen lassen, wenn es schnell geht.

## Acceptance criteria
1. Beide Writer nutzen `recorder_encode_policy.h`; keine doppelte Bitrate-Formel mehr.
2. macOS-Writer setzt ColorProperties 709, Reordering NO, CABAC, ExpectedSourceFrameRate, Keyframe fps*2.
3. Video-PTS liegen auf dem `1/fps`-Gitter relativ zu `sessionStart`; Lücken werden bis 4 Frames gefüllt, >1 s springt; Drops durch `isReadyForMoreMediaData` committen nicht; Kill-Switch `BROADIFY_MEETING_RECORDER_CFR=0` stellt Host-Clock-PTS her.
4. Windows-Writer setzt die vier Farbraum-Attribute, Input-Range 0-255, GOP best-effort, CFR-Gitter.
5. `recorder_encode_policy_test` ist in CMake registriert und grün; `meeting_recorder_writer_test` grün (macOS).
6. Allowlist + Jest-Test erweitert; `npm run lint` grün.
7. Doku aktualisiert.

## Review
- Round: 2/3
- Verdict: PASS nach Runde 2 (Runde 1 Verifier 2.10.2026: AC1/2/3/6/7 PASS, AC4 PASS per Code-Review, AC5 Teil-FAIL → 2 MUST-FIX; Runde 2 Fixes durch Codex, Re-Verifikation durch Orchestrator: `npm run build:meeting-helper` Exit 0, `npm run test:meeting-helper-native` 34/34 passed inkl. `meeting_recorder_writer_test` (2,55 s) und `recorder_encode_policy_test`, `npm run lint` Exit 0).
- Must-fix (open): keine
- Must-fix (resolved):
  1. `tests/meeting_recorder_writer_test.mm` öffnete `AVAsset` auf der `.mp4.part`-Sidecar (AVFoundation verweigert die Endung, AVError -11828). Fix: Sidecar wie in Produktion auf den finalen `.mp4`-Pfad verschieben und dort sondieren. (Das in der Codex-Sandbox gemeldete `audio_input_rejected` war ein Sandbox-Artefakt.)
  2. `meeting_recorder_mediafoundation.cpp` ICodecAPI: `#include <initguid.h>` vor `<codecapi.h>` plus `<icodecapi.h>` (Windows-only, Muster `vcam-helper/windows/dllmain.cpp`); die TU definiert sonst keine GUIDs. Windows-Compile weiterhin nur über CI/Windows-Laptop belegbar.
- Notes (non-blocking):
  1. `RecorderFrameClock::plan` nicht `const` (braucht `firstIndex` für `commit`) — sinnvolle Abweichung.
  2. macOS `droppedFrames` überzeichnet bei Backpressure (nur intern).
  3. `appendVideoFrame` hält den Impl-Mutex über bis zu 4 Appends; Audio-Delegate konkurriert (begrenzt).
  4. Bei `plan.count == 0` wird der Pool-Buffer trotzdem gefüllt (nur CPU).
  5. Windows-`logRecorderEvent` ohne `jsonEscape`; Allowlist-Eintrag nicht alphabetisch.
- Handoff to human (if any): Windows-Compile nur über `test-release/**`-Push oder Windows-Laptop; echte Aufnahme-Probe (12 Mbit/s/~26 fps → ~22 Mbit/s/30 CFR/bt709) braucht Hardware → RC-Feldtest. Verifier-Sonde: 709-Tags, nominalFrameRate 30.000, 90/90 Samples exakt auf dem 1/30-Gitter nachgewiesen.

## Verification
- [ ] Tests pass (ctest + Jest)
- [ ] Lint / type-check pass
- [ ] `npm run build:meeting-helper && npm run test:meeting-helper-native` (Verifier, macOS)
- [ ] Bug reproduced before the fix, gone after (Probe: 12 Mbit/s / ~26 fps VFR / ohne colr → ~22 Mbit/s / 30 fps CFR / bt709)
