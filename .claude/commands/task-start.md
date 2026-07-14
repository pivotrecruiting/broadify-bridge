---
description: Start a task in an isolated worktree with a clean TASK.md contract.
argument-hint: <slug> [base-branch]
---

You are the ORCHESTRATOR. Set up an isolated environment for a new task.
Do NOT write any feature code in this step.

- Task slug: `$1`
- Base branch: `$2` (use `dev` if empty)

Steps:

1. Run `bin/wt.sh inventory` and read the output. Report to the human, briefly:
   existing worktrees, in-progress local branches, stashes, and open PRs.

2. **Overlap decision.** Does this task plausibly touch the same files/area as an
   in-progress branch or the human's uncommitted work?
   - Default (no overlap): create a fresh, isolated worktree from the base branch.
   - If there IS plausible overlap: **STOP and ask the human** whether to branch
     off that work or start clean. Do not decide silently. Never build on the
     human's work-in-progress without explicit confirmation.

3. After deciding (or being confirmed clean), create the worktree:
   `bin/wt.sh new $1 $2`  (base defaults to `dev`).

4. Copy `templates/TASK.md` into the new worktree as `TASK.md`. Fill in the
   Title and the Raw request (the transcribed/summarized customer message).
   Leave Plan and Acceptance criteria empty — those come in `/task`.

5. Tell the human the worktree path, and that the next step is to `cd` there and
   run `/task`.
