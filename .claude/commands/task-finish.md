---
description: Verify, commit, push the feature branch, open a PR, and present it for confirmation. Does NOT merge.
---

Preconditions: `TASK.md` shows **PASS** and every acceptance criterion checked.
If not, stop and run `/task`.

Steps:

1. **Verify — delegate to the project's verification agents/skills.** Do NOT
   hardcode commands; the CLI agents already know this stack. Hand off and let
   them run the right tests, lint, and type-check. Guardrails:
   - The verifier must be a **different role than the implementer** (Codex).
   - Record the **actual results** (command output / exit status) in `TASK.md`,
     not a self-assessment.
   - If anything fails, **STOP — do not push.** Route failures back into `/task`.

2. **Browser check (if UI-affecting).** Drive the local dev deployment via the
   Chrome extension and confirm the fix/feature works — for a bug, reproduce that
   it is gone. Save a short note/screenshot for the PR body.

3. **Commit** (feature worktree, current identity) with a clear message
   referencing the task.

4. **Push the FEATURE branch.** Allowed. (Direct push to main/dev, force-push,
   and branch deletion are blocked by design.)

5. **Open a PR:** `gh pr create --base dev --fill`, using
   `.github/PULL_REQUEST_TEMPLATE.md`. Fill "How it was verified" from steps 1–2.
   (Requires `gh auth login` to be done once.)

6. **Present for confirmation — then STOP.** In the chat, give the human: a short
   summary of the change, the PR URL, the key diffs, and the verification results.
   Ask whether to merge, and to which branch. **Do NOT merge here.** Merging is a
   separate, explicitly-confirmed step: `/task-merge`.
