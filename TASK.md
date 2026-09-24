# Task: DeckLink helper batch — stale FrameBus reopen, lifecycle events, display-mode id, retries, error codes, diagnostics, torn-frame check (PR C-H, helper batch)

## Raw request
Audit rc.19 (24.9.2026), `apps/bridge/native/decklink-helper/src/decklink-helper.cpp` (macOS-only, 2550 lines). The TS
side (PRs C1, C3, C2) already tolerates every event/flag introduced here; this PR only changes the helper and its docs,
and the release requires a new prebuilt asset (see release steps).
- G1(c) defense in depth: the frame loop (~2080-2112) polls `seq` forever; if the region were ever recreated under the
  same name the helper would freeze (the meeting helper reopens after 2 s without progress:
  `apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:1791-1811`).
- G2: `ready` is emitted (~2042-2043) BEFORE `StartScheduledPlayback` (`maybeStartPlayback` ~1968-1997); a failed start,
  `ScheduledPlaybackHasStopped` (~1241-1243, no-op) or `scheduleFrame` failures (~1236, result ignored) never terminate
  the helper → the bridge keeps "ready" while the output is dead.
- G4: `findDisplayMode` (~1292-1371) matches `{w,h}` + fps only; 1080i50 vs 1080p25 ambiguous; `--display-mode <id>`
  is already sent by the bridge (PR C3) and silently ignored by the current binary.
- G7: `EnableVideoOutput` retries 3×250 ms only on E_ACCESSDENIED (~46-47, ~1905-1928); `findDeckLinkById` (~1749-1753)
  and keyer `Enable` (~1942-1960) have no retry → cold-start races end in exit 1.
- G9: causes only on stderr; TS shows "exited before ready (code 1)".
- G10: `--list` prints `[]` with exit 0 when the API is unavailable (~478-483); no API version; `--watch` with a null
  discovery returns 1 silently (~2297-2301).
- G14: the reader copies slot `(seq-1) % slot_count` without re-checking `seq` after the memcpy (~2104-2110) → torn frames
  possible with 2 slots (TS raises the default to 3 in PR C4; the check still belongs here).

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/decklink-helper-batch / feature/decklink-helper-batch
- Base: origin/dev after Wave 1 (C2 #212, C3 #209, C4 #210 merged; the TS event parser and docs are present). Target dev.
- Build: `bash apps/bridge/native/decklink-helper/build.sh` needs `DECKLINK_SDK_ROOT/Mac/include` (SDK with
  `DeckLinkAPIDispatch.cpp`) and `/Library/Frameworks/DeckLinkAPI.framework` (Desktop Video 16.3 installed here). SDK provided by
  Gabriel: `DECKLINK_SDK_ROOT="/Users/gabrielbaeuerle/Downloads/Blackmagic DeckLink SDK 16.0"` (API 16.0 headers incl.
  Mac/include/DeckLinkAPIDispatch.cpp; runtime Desktop Video 16.3). The unchanged helper builds and runs with it (verified). Prebuilt asset flow: `scripts/prepare-decklink-helper-release.sh` → upload
  `decklink-helper-arm64` → secrets `DECKLINK_HELPER_URL_ARM64`/`_SHA256_ARM64` (DEPLOY.md). No C++ test target exists;
  add a SDK-free policy header + a tiny clang++ test (see below).
- Conventions: C++17, English comments, additive stdout protocol (`ready` semantics unchanged), no new dependencies.

## Plan
1. `src/framebus-reader-policy.h` (SDK-free, header-only): `shouldReopenStaleReader(nowNs, lastProgressNs, thresholdNs)`
   and `isTornRead(seqBefore, seqAfter, slotCount)`; `tests/reader-policy-test.cpp` (plain `clang++ -std=c++17` + asserts,
   documented in README; run by the verifier).
2. Stale reopen (frame loop ~2080-2112): track `lastProgressNs`; after 2 s without a new `seq` → `closeFrameBusReader`,
   `openFrameBusReader(config.frameBusName)` + geometry checks (~2006-2040) again; on failure keep repeating `lastFrame`
   and retry every 5 s; stderr gate one line per cycle; reset `lastSeq = 0` after reopen.
3. Lifecycle events: `ready` += `"helperVersion":"<semver>"` (constant `kHelperVersion`); after a successful
   `StartScheduledPlayback` emit `{"type":"playback_started"}`; on failure `{"type":"fatal","code":
   "start_scheduled_playback_failed","message":"HRESULT=0x…"}` → `gShouldExit = true`, exit code 3;
   `ScheduledPlaybackHasStopped` → `fatal playback_stopped` + exit 3 unless our own stop is in progress (`gStopRequested`);
   `scheduleFrame` failures counted in the completion callback, ≥ 30 consecutive → `fatal schedule_frame_failed`.
   `emitFatal(code, message, hresult?)` before every `return 1` in `runPlayback` with codes: `invalid_config`,
   `device_not_found`, `output_interface_unavailable`, `no_external_keying`, `no_supported_mode`, `connection_unsupported`,
   `enable_video_output_failed`, `device_busy` (E_ACCESSDENIED), `keyer_enable_failed`, `framebus_open_failed`,
   `framebus_geometry_mismatch`.
4. `--display-mode <id>`: `PlaybackConfig.displayModeId` (0 = unset), CLI parsing (~2385ff), `findDisplayMode` prefers the
   exact `GetDisplayMode() == id` (still `DoesSupportVideoMode` over the pixel-format priority); no match →
   `{"type":"warning","code":"display_mode_id_not_found"}` + today's heuristic. Selection log line keeps field dominance.
5. Retries: `EnableVideoOutput` 10×500 ms (E_ACCESSDENIED always; E_FAIL in the first 3 attempts); `findDeckLinkById`
   6×500 ms with stderr "waiting for device"; keyer `Enable(true)` 4×250 ms. Worst case ≈ 9 s (TS ready timeout 12 s).
6. Diagnostics: `--list --with-diagnostics` → `{"devices":[…],"diagnostics":{"apiAvailable":bool,"apiVersion":"<from
   IDeckLinkAPIInformation BMDDeckLinkAPIVersion>","helperVersion":"…","error":null|"…"}}` (plain `--list` unchanged);
   `--version` → `{"type":"version","helperVersion":"…","builtAt":"…"}`; `--watch` without discovery → `fatal
   api_unavailable`, exit 2.
7. Torn-frame check: after the slot memcpy re-read `seq`; if `isTornRead(seqBefore, seqAfter, slot_count)` discard and
   re-read (bounded), count `tornFrames` in the `metrics` event.
8. Docs: `native/decklink-helper/README.md` (protocol table, flags, exit codes, policy test), `DEPLOY.md` (compat rule
   "TS first, asset second; old helper = no events", SDK root), `docs/bridge/architecture/graphics-realtime-output-helper-contract.md`,
   `docs/bridge/subsystems/output-helper.md`, `docs/bridge/reference/files/decklink-helper-cpp.md`.

## Acceptance criteria
1. `tests/reader-policy-test.cpp` passes (stale threshold boundaries; torn detection for slotCount 2 and 3).
2. Helper builds with `build.sh` against the release SDK (verifier on Gabriel's Mac; report SDK version and
   `./decklink-helper --version`).
3. Manual protocol with UltraStudio (verifier, documented in the report): `--list --with-diagnostics` envelope; playback
   emits `ready` then `playback_started`; unplug → `fatal` + exit 3; `--display-mode <1080i50 id>` selects the interlaced
   mode (log line); kill -9 of the renderer → helper log shows `stale reopen` only if the region was recreated (with PR C1
   it should NOT reopen); Desktop Video Setup holding the device → `device_busy` fatal with hresult.
4. TS suites unaffected (no TS change in this PR); `npm run lint` unchanged.

## Release steps (after merge)
`DECKLINK_SDK_ROOT=<path> bash scripts/prepare-decklink-helper-release.sh` → upload `decklink-helper-arm64` to the helper
release → set `DECKLINK_HELPER_URL_ARM64` / `DECKLINK_HELPER_SHA256_ARM64` → cut RC → bridge log `[DeckLinkOutput]
helperVersion=…` / `list_outputs.diagnostics.decklink.helperVersion`.

## Review
- Round: 1/3
- Verdict: must-fix applied
- Must-fix (applied): corrected `isTornRead` reuse boundary from `>= slotCount`
  to `>= slotCount - 1` (slotCount 1: any sequence change is torn), and updated
  slotCount 2/3 boundary tests plus README wording.
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Added SDK-free reader policy helpers/tests for stale reopen and torn-read
  detection.
- DeckLink helper now emits additive helper/version, diagnostics, warning,
  playback_started and fatal events; `ready` remains the readiness signal.
- Hardware playback paths are implemented by code review only in this worktree;
  no UltraStudio is attached.

## Verification
- [x] Policy test passes; helper builds against the release SDK
- [ ] Manual protocol with hardware (verifier)
- [x] Docs updated

## Build command (verified on this Mac)
```bash
DECKLINK_SDK_ROOT="/Users/gabrielbaeuerle/Downloads/Blackmagic DeckLink SDK 16.0" bash apps/bridge/native/decklink-helper/build.sh
./apps/bridge/native/decklink-helper/decklink-helper --list      # [] without a device
./apps/bridge/native/decklink-helper/decklink-helper --version   # new in this PR
```
