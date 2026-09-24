# Task: ATEM USB helper protocol v2 — heartbeat, macro ack, HRESULT diagnostics, device_busy, SIGTERM teardown (PR B5, helper batch)

## Raw request
Audit rc.19 (24.9.2026), USB transport (`apps/bridge/native/atem-usb-helper/src/atem-usb-helper.cpp` + TS adapter
`apps/bridge/src/services/engine/adapters/atem-usb-adapter.ts`):
- E4 (HIGH): no liveness signal between bridge and helper. A helper blocked inside the Blackmagic SDK (or a silent unplug
  without the SDK callback `bmdSwitcherEventTypeDisconnected`, helper ~482-488/566-569) keeps the UI "connected";
  `macro_run` has no acknowledgement — the adapter marks the run accepted right after writing to stdin (TS ~267-272) and
  a 750 ms timer completes it (TS ~523-540) regardless of what the helper did.
- E5 (MEDIUM): `RunSession::connect` discards the `ConnectTo` HRESULT (`connectViaUsb(...) != S_OK`, helper ~553-558;
  macOS uses `== S_OK`, Windows `SUCCEEDED`) and `failReason` defaults to `NoResponse` → "device busy" (E_ACCESSDENIED,
  e.g. ATEM Software Control holds the switcher) is reported as `no_usb_switcher_found` ("check the USB cable"). The SDK
  enum has no busy value (BMDSwitcherAPI.h:1253-1258); only the HRESULT can tell. QueryInterface HRESULTs (~561-564) are
  discarded too.
- E6 (MEDIUM, macOS): the helper has no signal handling at all; Electron stops the bridge with a process-group SIGTERM
  (`src/electron/services/bridge-process-stop.ts:14-21`, group created by `bridge-process-manager.ts:189 detached`), so
  the helper dies without `disconnectLocked` → SDK session not released → first connect after an app restart can fail
  until re-plug (field observation 18.9.). On Windows only the bridge is killed and the helper ends via stdin EOF (fine).

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/atem-usb-helper-v2 / feature/atem-usb-helper-v2
- Base: feature/engine-connection-supervisor (PR B4) — includes B1 (error codes), B2, B3 (awaited stop). Target dev.
- Helper release facts: CI never builds the helper (`SKIP_ATEM_USB_HELPER_BUILD=1`); release builds download prebuilt
  assets via secrets `ATEM_USB_HELPER_URL_{ARM64,X64,WIN}` + `_SHA256_*` (`.github/workflows/release.yml:47-52`,
  `scripts/download-atem-usb-helper.sh`); macOS build needs the ATEM SDK at
  `/Applications/Blackmagic ATEM Switchers/Developer SDK/Mac OS X` (present on this Mac; `build.sh`), Windows builds via
  `.github/workflows/atem-usb-helper-win.yml` (`build.ps1`, vendored interop header, `--probe` smoke). TS MUST stay
  compatible with the OLD helper binary: feature-detect via `protocol_version` in the `ready` event (today `ready` only
  carries `helper_build`, helper ~850-857); the old helper answers unknown commands with `error unknown_command`
  (~884-886) — the adapter must not treat that as a runtime error.
- Conventions: C++17, comments in English, no SDK files committed; TS as in the other engine PRs; fake timers for the
  heartbeat tests; `atem-usb-adapter.test.ts` child fake (`emitHelperLine`, `flush`).

## Plan
### Helper (`atem-usb-helper.cpp`)
1. `constexpr int kHelperProtocolVersion = 2;` — add `"protocol_version":2` to `ready` (~850-857) and to the `--probe` JSON
   (~830-841).
2. Reader loop (~865-887): `ping` → `{"type":"pong","seq":N}` (echo `seq` if present) emitted immediately under
   `gStdoutMutex` only (never under `mutex_`); `macro_run` reads optional `req` (new `extractJsonUInt`) →
   `session.runMacro(index, hasReq, req)`; with `req` the helper answers `{"type":"ack","command":"macro_run","req":N,
   "index":I}` on success or `{"type":"nack","command":"macro_run","req":N,"index":I,"error":"invalid_macro_index|
   macro_run_failed|not_connected"}`; without `req` the legacy `error` events stay (new helper ↔ old bridge).
3. HRESULT: `connectViaUsb` macOS path uses `SUCCEEDED(result)` (CFPlugInCOM.h defines it); callers (~554 and `runProbe`
   ~785) use `FAILED(hr) || switcher_.empty()`; new `classifyConnectFailure(hr, reason)`: `hr == E_ACCESSDENIED
   (0x80000009 mac / 0x80070005 win)` → `"device_busy"`, else `connectFailureToError(reason)`; `formatHRESULT` made
   platform-neutral (today inside `_WIN32`, ~306-311); `emitConnectError(code, hr, reason)` →
   `{"type":"error","error":"device_busy","detail":"hr=0x80000009 fail_reason=no_response","hr":"0x80000009",
   "fail_reason":"no_response"}`; QueryInterface failures logged to stderr with hr (session stays usable, macro pool null
   is tolerated by `emitMacrosUnlocked` ~691-694). `--probe` error JSON also carries `hr`/`fail_reason`.
4. Signals (`#if !defined(_WIN32)`): in `main` BEFORE creating any thread: block SIGTERM/SIGINT/SIGHUP with
   `pthread_sigmask(SIG_BLOCK, …)` (threads inherit), `signal(SIGPIPE, SIG_IGN)`; in `runSessionLoop` a dedicated
   `std::thread signalThread` doing `sigwait` → sets `g_terminateRequested` and `CFRunLoopStop(CFRunLoopGetMain())`;
   after `CFRunLoopRun()` (~900) when the flag is set: `session.disconnect()` (SDK teardown under `mutex_`), flush stdout,
   detach reader/signal threads, `_exit(0)`. Normal path (stdin EOF / `shutdown`) unchanged. Windows path untouched.
   Emit `{"type":"disconnected"}` from the teardown as today (`disconnectLocked` does).
5. README (`apps/bridge/native/atem-usb-helper/README.md`): commands/events table incl. `ping/pong`, `ack/nack`,
   `protocol_version`, `hr`/`fail_reason`, signals; DEPLOY.md: compatibility rule "TS first, asset second; old helper =
   v1 fallback" and the release steps below.
### TS (`atem-usb-adapter.ts`, `engine-errors.ts`, `routes/engine-contract.ts`, tests)
6. Constants `HEARTBEAT_INTERVAL_MS = 5000`, `HEARTBEAT_MAX_MISSES = 2`, `MACRO_ACK_TIMEOUT_MS = 2000`,
   `HELPER_PROTOCOL_HEARTBEAT_MIN_VERSION = 2`. `HelperEventT` += `protocol_version?, seq?, req?, command?, hr?, fail_reason?`.
   On `ready` store `helperProtocolVersion` (missing → 1) and log `[AtemUsb] Helper protocol v<N>`.
7. Heartbeat (v ≥ 2 only): after `connected` start an unref'd interval; if a ping is still pending → `missedPongs++`; at
   `HEARTBEAT_MAX_MISSES` → log `[AtemUsb] Helper unresponsive (2 missed heartbeats), stopping helper`,
   `setState({ status: "disconnected" })`, `void stopHelper()` (the B4 supervisor reconnects). `pong` resets. Stop the
   interval in `disconnect`, `handleHelperExit`, `failConnect`.
8. Macro ack (v ≥ 2 only): `runMacro` sends `req`, keeps a pending map `{ resolve, reject, timer }`; `ack` → today's
   accepted/pending-completion path; `nack` → `macroExecutionStore.fail(error)`, rebuild, throw `EngineError`
   (`not_connected` → `createNotConnectedError("run macro")`, else `PROTOCOL_ERROR` with `details.reason`); timeout →
   `fail("macro_ack_timeout")` + `EngineError(PROTOCOL_ERROR, …, { reason: "macro_ack_timeout" })`. v1 keeps today's
   fire-and-forget path. `handleHelperError`: `unknown_command` → debug log only.
9. `mapConnectError(error, event)`: `device_busy` → new `createUsbDeviceBusyError(detail)` (`EngineErrorCode.DEVICE_BUSY`,
   message "The ATEM switcher is already in use by another application (e.g. ATEM Software Control). Close it and try
   again."); attach `details: { hr, failReason }` to all USB connect errors; extend the `no_usb_switcher_found` text with
   "…or the switcher is currently claimed by ATEM Software Control". `engine-contract.ts`: `DEVICE_BUSY` → 409.
10. CI smoke (`.github/workflows/atem-usb-helper-win.yml` ~28-35): also assert `"protocol_version":2`.

## Acceptance criteria (RED before unless guard)
1. "sends ping every 5s and treats two missed pongs as a helper drop" (fake timers; after 15 s status `disconnected`,
   shutdown written) — RED before. 2. "does not send pings to a protocol v1 helper" (ready without protocol_version).
3. "runMacro resolves on ack and marks the execution accepted", "rejects with PROTOCOL_ERROR on nack and fails the
   execution", "rejects when no ack arrives within 2s" — RED before. 4. "keeps fire-and-forget semantics for protocol v1
   helpers" (existing test stays green). 5. "ignores unknown_command errors from older helpers" (no `state.error`).
6. "maps device_busy to DEVICE_BUSY and keeps hr in details" — RED before; `engine-errors.test.ts` factory; engine-contract
   409. 7. Helper manual protocol (documented in the report, run by the verifier on macOS with the SDK):
   `bash apps/bridge/native/atem-usb-helper/build.sh && ./apps/bridge/native/atem-usb-helper/atem-usb-helper --probe` shows
   `"protocol_version":2`; `--run` + `{"command":"ping","seq":1}` → `pong`; `kill -TERM <pid>` → `disconnected` event +
   exit 0; with the ATEM connected `{"command":"macro_run","index":99,"req":1}` → `nack invalid_macro_index`.
8. `npx jest apps/bridge/src/services/engine apps/bridge/src/services/engine-adapter.test.ts apps/bridge/src/routes --runInBand`;
   FULL `npm run test:jest` (verifier); `npm run lint`; `npm run build:bridge`.

## Release steps (after merge; Gabriel + Claude)
1. macOS arm64: `npm run prepare:atem-usb-helper-release` → asset `atem-usb-helper-arm64` + SHA256 (x64 if a machine is
   available). 2. Windows: run workflow "ATEM USB Helper Windows" (workflow_dispatch) → artifact `atem-usb-helper-win-x64`.
3. Upload assets to the private assets release; update secrets `ATEM_USB_HELPER_URL_*` / `_SHA256_*`. 4. Cut the RC; verify
   the bridge log line `[AtemUsb] Helper protocol v2`. 5. Hardware protocol B (scenarios 4, 5, 6, 13, 14).

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes

- Implemented helper protocol v2 (`protocol_version`, `ping`/`pong`, macro `ack`/`nack`, HRESULT/fail_reason diagnostics, device_busy classification, macOS signal teardown).
- Implemented TS v2 feature detection with v1 fallback, heartbeat drop handling, macro ack timeout handling, `unknown_command` ignore, `DEVICE_BUSY` mapping, and structured macro/vMix route `EngineError` responses.
- Local full Jest remains blocked by sandbox socket binding in `apps/bridge/src/services/graphics/renderer/electron-renderer-client.test.ts` (`listen EPERM: operation not permitted 127.0.0.1`); targeted Jest passes.
- Helper build/probe and no-hardware protocol smoke passed locally; ATEM-connected invalid macro `nack` and connected SIGTERM `disconnected` event still require hardware/verifier.

## Verification
- [ ] Tests pass (targeted + full)
- [x] Lint / type-check pass
- [ ] Helper built locally, manual protocol checked (verifier)
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after

## Addendum (from the 24.9. end-to-end run against the real ATEM)
- HTTP `POST /engine/macros/:id/run` and `/stop` (`apps/bridge/src/routes/engine.ts` ~237-330) answer an `EngineError`
  with `{ success:false, error:"Engine not connected", message:"…" }` (HTTP 503) — no `code`. The connect route already
  returns `error.toJSON()` (`{ code, message, details }`). Make the macro routes (and `/engine/vmix/actions/run`) return the
  same shape (`error: error.toJSON()`) plus `mapEngineErrorToStatusCode`, without changing the relay path. Test:
  `routes/engine.integration.test.ts` "macro run while disconnected returns code NOT_CONNECTED" (RED before).
