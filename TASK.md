# Task: DeckLink device/protocol hardening — displayModeId, diagnostics, detection budget, owned ports, platform (PR C3)

## Raw request
Audit rc.19 (24.9.2026), Studio graphics / UltraStudio detection (macOS-only DeckLink path):
- G4 (HIGH): the output format is `{width,height,fps}` only (`apps/bridge/src/services/graphics/schemas/output-schemas.ts:24-28`),
  so 1080i50 and 1080p25 are indistinguishable; the helper picks the first `{w,h,fps}` match
  (`native/decklink-helper/src/decklink-helper.cpp:1292-1371`). `--list-modes` already emits `id` and `fieldDominance`
  and the webapp has them in the select value but drops them from the payload.
- G10 (MEDIUM): missing/old Desktop Video driver → helper `--list` prints `[]` with exit 0 and a stderr hint that TS
  discards (`apps/bridge/src/modules/decklink/decklink-helper.ts:146-166`) → silent empty list, no cause anywhere.
- G11 (MEDIUM): `DecklinkModule` has no `detectionTimeoutMs` (default 5 s, `modules/module-registry.ts:8`) while
  `detect()` spawns 1 + 2×N helper calls with 4 s each (`decklink-detector.ts:213-284`) → structural timeout risk.
- G12 (MEDIUM): the bridge's own playback marks the device busy, so `list_outputs` shows all of its ports as
  unavailable (`decklink-detector.ts:110-113`, `routes/outputs.ts:46-50`); `routes/outputs.ts:20-75` also duplicates
  `services/device-to-output-transform.ts`.
- G13 (HIGH gap): Windows has no DeckLink module at all (`modules/index.ts:19-22`); neither the bridge status nor the
  outputs list tells the webapp, so Windows users see "no outputs" without explanation.

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/device-protocol-diagnostics / feature/device-protocol-diagnostics
- Base branch: dev (origin/dev dd5d6932 == v0.27.1-rc.19)
- Hard rules (AGENTS.md): Graphics Single-Path; all inputs Zod-validated; JSON keys snake_case where that is the
  established convention of the payload (bridge status / outputs use camelCase today — keep each payload's existing
  style); docs under docs/bridge/* updated in the same change.
- Compatibility facts (verified): nested Zod objects strip unknown keys, so an OLD bridge silently drops
  `format.displayModeId`; the helper's `--playback` argument loop has no else-branch, so an OLD helper binary skips
  `--display-mode <id>` silently (decklink-helper.cpp:2385-2488) and `--list` ignores all extra args (2281-2294);
  the persisted config store parses with `GraphicsConfigureOutputsSchema` (`output-config-store.ts:123`), so an
  optional field added there flows through. NO native helper change in this PR (helper batch is a separate PR).
  The webapp side (sending `displayModeId`, rendering hints) is a separate webapp PR — this PR must be safe with the
  current webapp.

## Plan
### 1. G4 — optional `displayModeId` end-to-end (bridge side)
- `output-schemas.ts:24-28`: `displayModeId: z.number().int().positive().optional()` on `GraphicsFormatSchema`.
- `graphics-output-validation-service.ts` `validateOutputFormat` (~183-261): DeckLink path — when
  `format.displayModeId` is set, require `modes.some((mode) => mode.id === format.displayModeId)` among the modes
  returned by `listDecklinkDisplayModes(...)`, else throw `Error("Selected display mode is not offered by the device")`;
  display path ignores the field. Keep the existing w/h/fps checks.
- Adapter args: `graphics/output-adapters/decklink-key-fill-output-adapter.ts` (~68-88) and
  `decklink-video-output-adapter.ts` (~64-82): append `"--display-mode", String(config.format.displayModeId)` only
  when set.
- Protocol: no payload type lives in `packages/protocol` for this command (only `OutputDisplayModeT`), so no change
  there beyond G12/G13 below.

### 2. G10 — diagnostics instead of a silent empty list (TS only)
- `modules/decklink/decklink-helper.ts`: add `listDecklinkDevicesWithDiagnostics(): Promise<{ devices: unknown[];
  diagnostics: DecklinkDiagnosticsT }>` that accepts BOTH the current array output and a future envelope
  `{ devices: [...], diagnostics: {...} }` (validate with Zod; unknown shape → `[]` + diagnostics.error), captures
  stderr even on exit 0 (today dropped at ~146-166) into `diagnostics.error`/`message`, maps the known stderr hint
  "DeckLink iterator could not be created" to `apiAvailable: false`, and records `helperMissing` when the helper path
  is not executable. Keep `listDecklinkDevices()` as a thin wrapper.
- `modules/decklink/decklink-detector.ts`: remember the last diagnostics (`getLastDiagnostics()`); `DecklinkModule`
  (`modules/decklink/index.ts`) exposes it.
- New `apps/bridge/src/services/output-diagnostics.ts` (+ test): `buildOutputsDiagnostics()` →
  `{ platform: NodeJS.Platform; decklink: { state: "ok" | "unsupported_platform" | "helper_missing" | "api_unavailable" | "no_devices"; apiVersion?: string; helperVersion?: string; message?: string } }`
  (`unsupported_platform` when the module is not registered for this platform, i.e. non-darwin).
- Attach `diagnostics` to the outputs payload in `services/command-router.ts` (`list_outputs`, ~177-197) and
  `routes/outputs.ts`. Protocol `packages/protocol/src/index.ts` `BridgeOutputsT` (~137-140) gets optional
  `diagnostics?: BridgeOutputsDiagnosticsT` (export the type). Rebuild protocol (`npm run build:protocol`).
- Do NOT implement a watch-process restart here (it needs the shared backoff scheduler from the engine PRs; it is
  scheduled for PR C2). Only add an `exit`/`close` handler to `watchDecklinkDevices` (~280-343) that logs at warn once
  with code/signal so a dead watcher is at least visible.

### 3. G11 — detection budget
- `modules/decklink/index.ts`: `readonly detectionTimeoutMs = 12_000` (pattern `modules/display/display-module.ts:295-297`).
- `decklink-detector.ts`: cache display modes per port (`Map<portId, { modes; cachedAt }>`, TTL 60 s), invalidated
  from the module's watch callback on `device_added`/`device_removed`; limit concurrent per-device mode queries to 2
  devices at a time (SDI + HDMI of one device may stay parallel as today).

### 4. G12 — own playback must not hide the device
- `services/device-to-output-transform.ts`: add `options?: { ownedPortIds?: ReadonlySet<string> }`;
  `available = (present && ready && !inUse && port.status.available) || owned`; set `ownedByBridge: owned` on the
  entry. Protocol `OutputDeviceT` (~110-121) gets optional `ownedByBridge?: boolean`.
- `routes/outputs.ts:20-75`: delete the duplicated mapping, import and use the transform; pass owned ports from
  `graphicsManager.getStatus().outputConfig?.targets` (`output1Id`, `output2Id`). Same in `command-router.ts`
  `list_outputs`.

### 5. G13 — platform + capabilities visible
- `get_status` in `command-router.ts` (~104-125) and `routes/status.ts` (~59-75): add `platform: process.platform` and
  `outputCapabilities: { decklink: process.platform === "darwin" }`. Protocol `BridgeStatus` (~27-45) additive,
  optional fields.
- `diagnostics.decklink.state === "unsupported_platform"` on win32 (from §2).

### 6. Docs (same change)
- `docs/bridge/features/output-config.md`: `displayModeId` (semantics, fallback to the w/h/fps heuristic, interlaced
  limitation: progressive 25 fps frames are delivered inside a 50i container, no field-accurate motion); fix the stale
  line ~57 (`KEY_FILL_PIXEL_FORMAT_PRIORITY` is `["8bit_argb"]` only, see `output-format-policy.ts:12-16`).
- `docs/bridge/subsystems/device-discovery.md` (~48-58): budget table (module timeout 12 s, helper call 4 s, mode cache
  60 s), diagnostics field.
- `docs/bridge/features/device-outputs.md`: `available` formula with `ownedByBridge`, `diagnostics`.
- `docs/bridge/subsystems/output-helper.md` (~44-48): platform matrix gets a DeckLink row "macOS only";
  `docs/bridge/features/relay-protocol.md` / `graphics-commands.md`: new `get_status` fields and `list_outputs.diagnostics`.

## Acceptance criteria
1. `schemas/output-schemas.test.ts`: NEW "accepts optional displayModeId" and "rejects a non-integer displayModeId".
   Second RED before (today unknown key is stripped, not rejected — assert the parsed output contains the id).
2. `graphics-output-validation-service.test.ts`: NEW "rejects a displayModeId that the device does not offer" (RED
   before: passes today) and "accepts a matching displayModeId".
3. Adapter tests (`decklink-key-fill-output-adapter.test.ts`, `decklink-video-output-adapter.test.ts`): NEW "passes
   --display-mode when format.displayModeId is set" (RED before) and "omits --display-mode otherwise".
4. `decklink-helper.test.ts`: NEW "parses the diagnostics envelope", "falls back to array output from older helpers",
   "reports api_unavailable when the helper prints the iterator hint on stderr with exit 0" (RED before: stderr
   dropped), "logs once when the watch process exits" (RED before: no handler).
5. `output-diagnostics.test.ts`: states ok / unsupported_platform / helper_missing / api_unavailable / no_devices.
6. `command-router.test.ts`: NEW "list_outputs includes diagnostics", "list_outputs marks the active output ports as
   owned and available" (RED before), "get_status exposes platform and outputCapabilities" (RED before).
   `routes/outputs.integration.test.ts` and `routes/status` tests updated accordingly.
7. `device-to-output-transform.test.ts`: NEW "marks owned ports available and flags ownedByBridge" (RED before).
8. `modules/decklink/index.test.ts` (create if missing): "exposes detectionTimeoutMs 12000" (RED before);
   `decklink-detector.test.ts`: "reuses cached display modes within TTL", "refreshes modes after invalidation".
9. Existing suites stay green: `device-cache.test.ts`, `graphics-manager.test.ts`, `graphics-output-transition-service.test.ts`,
   `outputs.integration.test.ts`.
10. `npx jest apps/bridge/src/services/graphics/schemas apps/bridge/src/services/graphics/graphics-output-validation-service.test.ts
    apps/bridge/src/services/graphics/output-adapters apps/bridge/src/modules/decklink apps/bridge/src/services/device-to-output-transform.test.ts
    apps/bridge/src/services/output-diagnostics.test.ts apps/bridge/src/services/command-router.test.ts apps/bridge/src/routes --runInBand`
    green; FULL `npm run test:jest` green; `npm run lint` clean; `npm run build:protocol`, `npm run build:bridge` clean.
11. Behaviour with the CURRENT webapp and CURRENT helper binary is unchanged except: outputs of the active config are
    now selectable, `get_status`/`list_outputs` carry additive fields.

## Review
- Round: 1/3
- Verdict: Applied review fixes; pending re-verification.
- Must-fix (applied):
  - Extracted shared outputs assembly into `apps/bridge/src/services/outputs-view.ts`; both `list_outputs` and
    `GET /outputs` now use `buildBridgeOutputsView()`.
  - Removed production `unknown` diagnostics casts by adding optional `getLastDiagnostics?()` to `DeviceModule`.
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Files changed: bridge DeckLink helper/detector/module, output diagnostics, command router, outputs/status routes, graphics schema/validation/adapters, protocol types, targeted tests, and the docs listed in this task.
- No native helper protocol changes, no new graphics fallback paths.
- Full `npm run test:jest` is blocked in this sandbox by pre-existing `listen EPERM: operation not permitted 127.0.0.1` failures in `electron-renderer-client.test.ts`; reproduced from a clean `HEAD` archive in `/private/tmp`.

## Verification
- [ ] Tests pass (targeted + full `npm run test:jest`)
- [x] Lint / type-check pass (`npm run lint`, `npm run build:protocol`, `npm run build:bridge`)
- [ ] Hardware outcome check (verifier): with UltraStudio attached and Key&Fill running, `list_outputs` shows its
      ports `available: true, ownedByBridge: true`; selecting the 1080i50 mode sends `displayModeId` (after the webapp PR)
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
