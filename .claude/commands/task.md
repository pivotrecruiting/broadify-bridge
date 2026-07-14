---
description: Run the bounded plan -> implement -> review loop against TASK.md.
---

You are the ORCHESTRATOR / ARCHITECT / REVIEWER. Codex is the IMPLEMENTER.
Work only inside the current worktree, against `./TASK.md`, which is the contract
between you and Codex.

## Phase 1 — Plan (you)
- Read `TASK.md` and the relevant code. **Do not implement.**
- Write into `TASK.md`:
  - a concrete **Plan**, and
  - a numbered list of **Acceptance criteria** that are objectively checkable
    (each maps to a test, an observable behavior, or a file/state condition).
- Present the plan to the human and get a quick OK before dispatching to Codex.

## Phase 2 — Implement (Codex)
- Hand the Plan + Acceptance criteria to Codex. Codex implements **strictly**
  against them and reports what it changed plus any deviations.

## Phase 3 — Bounded review loop (you <-> Codex)
- `MAX_ROUNDS = 3`. Keep `Round: N/3` current in `TASK.md`.
- Review Codex's output **only** against the acceptance criteria + tests/lint/
  types. Produce a verdict:
  - **PASS** — every acceptance criterion met; tests/lint/types green.
  - **CHANGES** — a list of **MUST-FIX** items only.
- MUST-FIX is strictly limited to: breaks an acceptance criterion; fails
  tests/lint/types; a security issue; or diverges from the agreed plan.
  Everything else (style, taste, equivalent-but-different approaches, speculative
  improvements) goes under **Notes** in `TASK.md` and never triggers a round.
- If a review yields only Notes (no must-fix) → treat as **PASS**.
- If CHANGES: Codex addresses **only** the must-fix list; then you re-review and
  increment the round.

## Stop conditions (prevent infinite correction)
- **PASS** → proceed to `/task-finish`.
- **Round 3 ends without PASS** → STOP. Write a HANDOFF note in `TASK.md`
  summarizing the remaining blocker, and hand it to the human. Do **not** start a
  round 4.
- **Same item unresolved across 2 rounds** → STOP and escalate to the human
  rather than looping.
- Never re-open resolved items. Never expand scope beyond the acceptance criteria
  mid-loop.
