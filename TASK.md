# Task: Meeting screen sharing — PR4: bridge relay contracts, helper client, status typing, docs

## Raw request
Gabriel (4.10.2026): screen sharing in Meeting Mode on macOS and Windows. Plan approved 4.10.2026: `~/.claude/plans/ich-gehe-davon-aus-woolly-toast.md`. This PR exposes the helper's `screen.*` RPCs (PR1) over the relay and types the status.

## Context
- Customer / project: Broadify Bridge server (`apps/bridge/src`) + docs (`docs/bridge/*`).
- Worktree / branch: `broadify-bridge-worktrees/meeting-screenshare-bridge` / `feature/meeting-screenshare-bridge` (stacked on `feature/meeting-screenshare-helper`, PR1 commit 58e9ab14).
- Base branch: `dev` (after PR1 merges; PR base = PR1 branch until then).

## Plan
Plan file section "PR4". Contract section is binding. Brief: scratchpad `codex/pr4-bridge-contracts.md`.

## Acceptance criteria
1. Allowlist + policy entries for `meeting_screen_list|start|stop|pick`; `relay-command-policy.test.ts` green (order, SLA, invalidates); pick has `replayPolicy: "never"`.
2. Zod schemas `MeetingScreenStartSchema` / `MeetingScreenPickSchema` (`.strip()`), handler cases per camera pattern with `requestStatusPublish("screen_start"|"screen_stop"|"screen_pick")`, helper-client wrappers `screen.list|start|stop|pick`.
3. `MeetingStatusT` typed: `engine.screen_capture`, `program.media_layer.source`; `captured_frames` in `VOLATILE_COUNTER_KEYS`.
4. Manager: `screen_capture_*` stdout events force a publish; `screen_capture_error` and non-user `screen_capture_stopped` publish `meeting_error`; no crash-restart replay (documented).
5. Docs: new `docs/bridge/features/meeting-screen-sharing.md`; `meeting-status-contract.md`, `meeting-keyer-rendering-dataflow.md`, `meeting-helper-dev-setup.md`, helper README updated.
6. `npm run lint`, `npm run test:jest` (meeting + relay policy suites at minimum), `npm run build:bridge` green.

## Review
- Round: 1/3
- Verdict: PASS round 1 (4.10.2026; reviewer: Claude; verifier: separate agent — lint, jest 2321/2321 full suite, build:protocol/bridge, release-contracts 20/20, before-proof 16 red → 90 green, live client wrappers against the PR1 helper OK, static checks OK). Verifier incident: user's pre-existing stash was popped by mistake and restored via `git stash store` (same commit 8bcae78a); orchestrator re-verified stash list + clean trees.
- Must-fix (open): none after orchestrator fix.
- Notes (non-blocking):
  - Reviewer replaced the invented status example in `docs/bridge/features/meeting-screen-sharing.md` (`display:1`, `Built-in Display`, `authorized`, `enumeration:true` on macOS) with contract-accurate macOS and Windows examples and documented the `permission_status` values of this stage.
  - Production changes match the plan 1:1; `width`/`height` typed nullable (helper emits 0 when idle) — tolerant, accepted.
- Handoff to human (if any): merge only after explicit chat go.

## Verification
- [x] Tests pass (jest 2321/2321, verifier 4.10.)
- [x] Lint / type-check pass (verifier 4.10.)
- [x] Before/after: 16 failures without production files, green after pop (verifier 4.10.)
- [x] Live: helper-client `screenList/Stop/Pick/Start/getState` against the PR1 helper (stub) return the contract shapes (verifier 4.10.)
