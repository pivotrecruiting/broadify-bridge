# Task: Studio FrameBus reuse-by-name on renderer recovery + WebContents crash handling (PR C1)

## Raw request
Audit rc.19 (24.9.2026), CRITICAL: when the graphics renderer process dies mid-show and the client restarts it,
the new renderer creates the Studio FrameBus writer with `forceRecreate: true`
(`electron-renderer-entry.ts:457-459` `shouldForceRecreateFrameBus()` returns true for every non-meeting bus,
used at `:576`). The native addon then `shm_unlink`s the region and creates a NEW one
(`native/framebus/src/framebus-addon.cc:441-473`). The running DeckLink helper stays mapped to the OLD inode and
only polls `seq` (`native/decklink-helper/src/decklink-helper.cpp:2080-2085`) → output freezes on the last frame
(key stays on air), status remains "ready". Meeting buses already use `forceRecreate:false` and reuse the region
by name (proven in production). Second finding (MEDIUM): a Chromium render-process crash inside the offscreen
window (process survives) is not handled — no `render-process-gone`/`unresponsive` handler — and the 1 s heartbeat
keeps republishing the last frame, so the output silently freezes while everything reports healthy.

## Context
- Customer / project: Broadify Bridge Studio graphics (Key&Fill / video via DeckLink, display output)
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/renderer-framebus-reuse / feature/renderer-framebus-reuse
- Base branch: dev (origin/dev dd5d6932 == v0.27.1-rc.19)
- Hard rules (AGENTS.md): Graphics Single-Path — ONE renderer, FrameBus = data plane; NO multi-window fallback, NO
  bridge-side compositing, NO `BRIDGE_GRAPHICS_RENDERER_SINGLE` switch. Update docs under docs/bridge/*.

## Plan
Verified facts to rely on: the addon reuse path (`framebus-addon.cc:446-460, 483-504`) opens an existing region with
`shm_open(O_RDWR)` and accepts it when magic/version/header_size/width/height/fps/pixel_format/frame_size/
slot_count/slot_stride match; otherwise it throws "Existing shared memory has incompatible header|size", which the
renderer entry already self-heals by recreating with `forceRecreate: true` (`electron-renderer-entry.ts:578-600`).
Studio bus names are random per bridge run (`framebus-config.ts:45-47`), so cross-run collisions are impossible.
`writer.header.seq` is exposed to JS as a bigint (`framebus-client.ts` `FrameBusHeaderT.seq`). The forced recreate
was introduced in commit db93df0b ("updated keying pipeline for meeting") without a Studio rationale.

### 1. G1(a) Reuse by name (CRITICAL)
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`: delete `shouldForceRecreateFrameBus()`
  (457-459); in `writerOptions` (~576) set `forceRecreate: false`; remove the corresponding log field (~640) if it
  only reported that flag; extend the comment near 583-588: reuse by name is the normal case (renderer recovery
  attaches to the live region); recreate happens ONLY in the incompatible-region self-heal.
- Seed-skip: after the writer is created (~579/596), compute `const reusedRegionHasFrame = frameBusWriter.header.seq > 0n`.
  If there is no `carriedFrame` and `reusedRegionHasFrame`, do NOT write the idle/background seed frame (the region
  still holds the last frame of the previous renderer until `replayLatestLayers()` from the client arrives); call the
  existing paint-dedup invalidation so the next real paint is written; log `seededFrom: "existing_region"`.
  Put the decision into a pure helper `renderer/framebus-seed-frame.ts`:
  `shouldSeedFreshWriter({ carriedFrame: boolean, existingSeq: bigint }): "retained_frame" | "idle_color" | "existing_region"`
  with colocated test.
- Keep `framebusReattach` handling (718-733, 754-764) unchanged (meeting still needs it). `MEETING_GRAPHICS_FRAMEBUS_NAMES`
  may still be used by `isMeetingGraphicsBus()` (~1480) — do not remove that.

### 2. G8 WebContents crash / unresponsive (MEDIUM)
- In `ensureSingleWindow` (after the existing `paint` / `did-finish-load` wiring, ~1053-1060 / ~1193):
  register `webContents.on("render-process-gone", (_e, details) => void recoverSingleWindow(\`render_process_gone:${details.reason}\`))`,
  `window.on("unresponsive", ...)` arming a 5 s timer → `recoverSingleWindow("unresponsive")`, `window.on("responsive", ...)`
  clearing it.
- `recoverSingleWindow(reason)`: stop the FrameBus heartbeat (do not keep republishing a dead frame), destroy the
  window, call `ensureSingleWindow(...)` again with the current renderer config, replay layers from the existing
  in-entry snapshots (`singleLayerSnapshots`, ~161; reuse the existing replay/publish helpers — do NOT add a second
  window or any compositing path), log at warn with the reason. Count incidents: a SECOND incident within 60 s →
  `logger.error` and `process.exit(3)` so the client's bounded recovery (`electron-renderer-client.ts:497-515` treats
  code 3 / no signal as recoverable) takes over — safe only because of §1.
- Guard against re-entrancy (a recovery already in flight ignores further events).

## Acceptance criteria
1. `electron-renderer-entry.test.ts`: NEW "attaches to the existing FrameBus region by name without forceRecreate
   (studio bus)" — setup like the existing reattach test (~1428-1534): `createWriter` called once with
   `expect.objectContaining({ forceRecreate: false })` for a non-meeting bus name. RED before the fix.
2. NEW "skips the idle seed when the reused region already carries frames" — writer mock `header.seq = 5n`:
   `writeFrame` not called for the seed, log carries `seededFrom: "existing_region"`. RED before.
3. NEW "still force-recreates an incompatible region (self-heal)" — first `createWriter` throws
   `Error("Existing shared memory has incompatible header")`, second call has `forceRecreate: true`. (Guard, green before
   and after — document as guard.)
4. `framebus-seed-frame.test.ts`: three outcomes covered.
5. NEW "recreates the offscreen window and replays layers after render-process-gone" (mock `webContents.on` capture in
   the test harness, ~52-55), NEW "exits the process on the second render-process-gone within 60s" (`process.exit` spy),
   NEW "stops the heartbeat while the window is gone". RED before (no handler registered).
6. Existing suites stay green: `electron-renderer-entry.test.ts` (incl. meeting reattach case), `electron-renderer-client.test.ts`
   (recovery describe 627-727), `framebus-writer-match.test.ts`, `framebus-heartbeat.test.ts`.
7. `npx jest apps/bridge/src/services/graphics/renderer --runInBand` green; FULL `npm run test:jest` green; `npm run lint`
   clean; `npm run build:bridge` and `npm run build:graphics-renderer` clean.
8. Docs updated in the same change: `docs/bridge/subsystems/graphics.md` (new paragraph "Studio: Writer-Reuse by Name
   (Renderer-Recovery)" next to the existing 97-120 heartbeat/reattach section; renderer section mentions
   render-process-gone handling), `docs/bridge/architecture/graphics-realtime-framebus.md` (lifecycle rule: regions are
   reused by name, recreate only on incompatibility), `docs/bridge/reference/files/renderer-entry.md`.
9. Manual outcome check to be run by the verifier (documented in the report, not by you): with a DeckLink or display
   output running, `kill -9` the renderer process → output resumes after client recovery without helper restart; the
   bridge log shows no "recreating" line for the studio bus.

## Review
- Round: 1/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Changed `electron-renderer-entry.ts`, `framebus-seed-frame.ts`, colocated renderer tests, and the three requested docs.
- Studio FrameBus writer creation now reuses by name (`forceRecreate: false`), skips idle seeding when an existing region has `seq > 0`, and still force-recreates only incompatible regions.
- Added offscreen `render-process-gone` / `unresponsive` recovery with heartbeat stop, single-window recreation, layer replay, and exit-code 3 escalation on repeated failures within 60s.
- Review round 1 MUST-FIX: `recoverSingleWindow()` now ignores recovery events that arrive while recovery is already in flight before updating the repeat-failure timestamp, so same-incident follow-on events do not trigger `exit(3)`. Added regression coverage for an in-flight `render-process-gone` event and kept the repeated-incident exit test scoped to a second event after recovery completes.
- Deviation: full Jest and renderer-folder Jest are blocked in this sandbox by pre-existing `listen EPERM: operation not permitted 127.0.0.1` in `electron-renderer-client.test.ts`; proven with implementation/test/doc patch reversed via `/tmp/codex-renderer-framebus-reuse.patch`.

## Verification
- [ ] Tests pass (targeted + full `npm run test:jest`)
- [x] Lint / type-check pass (`npm run lint`, `npm run build:bridge`, `npm run build:graphics-renderer`)
- [ ] Browser-verified (n/a) / hardware outcome check (verifier)
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
