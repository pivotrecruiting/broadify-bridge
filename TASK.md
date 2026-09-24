# Task: Renderer paint dedup by exact compare; Studio FrameBus slot count 3 (PR C4 — G15 + G14-TS)

## Raw request
Audit rc.19 (24.9.2026), LOW:
- G15: the paint dedup in `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts` (~1135-1148 on rc.19)
  samples every 4093rd byte for a checksum and suppresses a frame for up to 1 s when the sample matches; small changes
  (e.g. a clock's seconds digits) can miss every sample and stall for up to a second.
- G14 (TS part): the Studio FrameBus uses `DEFAULT_SLOT_COUNT = 2` (`renderer/../framebus/framebus-config.ts:20`) while the
  DeckLink helper copies slot `(seq-1) % N` without re-checking `seq` after the copy — with two slots a fast writer can
  overwrite the slot being read (torn frame). Meeting buses already use 3 slots (`meeting-graphics-manager.ts:16`). The
  helper reads `slot_count` from the region header, so 3 is compatible with the current helper binary; the reader-side
  `seq` re-check itself belongs to the helper batch.

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/renderer-dedup-slots / feature/renderer-dedup-slots
- Base: feature/renderer-framebus-reuse (PR C1, 0065ee27). Target dev after C1 merges.
- Hard rules (AGENTS.md): Graphics Single-Path; docs under docs/bridge/* updated. Renderer entry tests exist
  (`electron-renderer-entry.test.ts`, `framebus-heartbeat.test.ts`, `framebus-writer-match.test.ts`).

## Plan
1. New pure module `renderer/paint-dedup.ts` (+ test): `shouldSkipIdenticalPaint({ buffer, lastWritten, nowMs,
   lastWrittenAtMs, windowMs })` → true only when `lastWritten` exists, `buffer.equals(lastWritten)` and
   `nowMs - lastWrittenAtMs < windowMs`. Replace the stride-4093 checksum in the entry with it; `invalidatePaintDedup()`
   drops the reference. `Buffer.equals` early-exits on the first differing byte (cheap for changed frames; ~1 ms memcmp
   for identical 8 MB frames).
2. `framebus-config.ts:20`: `DEFAULT_SLOT_COUNT = 3` (env override `BRIDGE_FRAMEBUS_SLOT_COUNT` unchanged). Check
   `framebus-layout.ts` size computation and the renderer client's ready gate (`electron-renderer-client.ts` ~862-867
   compares slot count with config) — both derive from the same config, keep them consistent. Update
   `framebus-config.test.ts` and any test asserting the old size.
3. Docs: `docs/bridge/subsystems/graphics.md` (dedup rule, slot count), `docs/bridge/architecture/graphics-realtime-framebus.md`
   (slot count default), `docs/bridge/dev/framebus-dev-setup.md` if it mentions the size.

## Acceptance criteria (RED before unless guard)
1. `paint-dedup.test.ts`: identical within window → skip; identical after window → write; differing single byte outside
   the old stride raster (e.g. index 1) → write (RED before when ported against the old checksum helper — document as
   red on the old implementation, or as guard if you cannot exercise the old code path).
2. `electron-renderer-entry.test.ts`: "writes a paint that differs from the last frame in a single pixel within 1 s"
   (RED before with the sampled checksum when the differing byte is not on the 4093 raster) and "skips a pixel-identical
   paint within 1 s" (guard).
3. `framebus-config.test.ts`: default slot count 3 (RED before).
4. Existing renderer/framebus suites green; `npx jest apps/bridge/src/services/graphics/renderer apps/bridge/src/services/graphics/framebus --runInBand`;
   FULL `npm run test:jest` (verifier); `npm run lint`; `npm run build:bridge`; `npm run build:graphics-renderer`.

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Changed `paint-dedup.ts`, `electron-renderer-entry.ts`, `framebus-config.ts`, colocated tests, and the three requested docs.
- Paint dedup now skips only exact pixel-identical buffers within the 1 s window; invalidation drops the retained paint buffer.
- Studio FrameBus default slot count is now 3; `BRIDGE_FRAMEBUS_SLOT_COUNT` override behavior is unchanged.
- Deviation: targeted/full Jest are blocked in this sandbox by pre-existing `listen EPERM: operation not permitted 127.0.0.1` in `electron-renderer-client.test.ts`; proven by reversing the working-tree patch and rerunning the same targeted command.

## Verification
- [ ] Tests pass (targeted + full; blocked by pre-existing `listen EPERM` in `electron-renderer-client.test.ts`)
- [x] Lint / builds pass
- [ ] Hardware outcome check (verifier): clock graphic ticks every second on the SDI output without stalls
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
