# Task: Meeting multi-client sync — PR-C: meeting status contract docs

## Raw request
Gabriel (2.10.2026): Meeting webapp on the bridge PC and a second webapp must stay in sync in both directions. Plan approved: `~/.claude/plans/erstelle-einen-plan-um-floofy-conway.md`, Stage 2 / PR-C (docs only; documents PR-A + PR-B).

## Context
- Customer / project: Broadify Bridge docs (`docs/bridge/*`, `docs/integration/*`).
- Worktree / branch: `broadify-bridge-worktrees/meeting-status-contract-docs` / `feature/meeting-status-contract-docs`
- Base branch: `dev`; merge after PR-A and PR-B.

## Plan
- New `docs/bridge/features/meeting-status-contract.md` (full `MeetingStatusT` shape, cadence 2 s / 6 s / 120 ms, forced reasons, volatile keys, multi-client semantics, keyer identity, compatibility).
- Updates: `relay-protocol.md` (bridge_event list), `meeting-helper-dev-setup.md` (publish cadence + volatile keys), `graphics-commands.md` (content layers via `content_source`), `README.md` index, `docs/integration/interfaces.md`, `dataflows.md`.

## Acceptance criteria
1. Every documented key/number traces to PR-A/PR-B source; nothing invented.
2. All listed docs updated and cross-linked; index entry present.

## Review
- Round: 2/3
- Verdict: PASS (2.10.2026, reviewer: Claude). Round 1: structure and facts verified against PR-A/PR-B source (manager keys, camera reasons, cadence constants, volatile keys); must-fix = invented example values (`selfie`, `blur`, `grid`, DirectML on macOS, cornerbug 0.02). Round 2: all example values enum-/default-valid.
- Must-fix (open): none
- Notes (non-blocking): no numeric bridge version in the sources → fields marked "seit Stage 2"; add the RC version once cut.
- Handoff to human (if any): merge after #231 and #232 (needs Gabriel's go).

## Verification
- [x] Docs reviewed against source (reviewer: every key/number spot-checked in meeting-status-types.ts, meeting-helper-manager.ts, status-publish-policy.ts, control_server.cpp)
- [x] Lint / type-check pass (n/a, docs only)
