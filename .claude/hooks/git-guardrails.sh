#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PreToolUse (Bash) guardrail for Claude Code.  No external dependencies.
#
# The agent may merge — but only after your explicit confirmation in the Claude
# chat (enforced by the doctrine + /task-merge; a hook can't see the chat).
#
# Structural floors kept here (do not block a confirmed merge):
#   - no force-push (history protection)
#   - no direct push to a protected branch (merges go via a PR)
#   - main/dev (master/develop) can NEVER be deleted — UNCONDITIONALLY, even if
#     no GitHub ruleset is in place, by any delete path
#   - the agent stays in feature worktrees (no checkout of protected)
# `gh pr merge` is intentionally ALLOWED — that is the confirmed-merge path.
#
# jq is used only if present (cleaner extraction). Without it, the hook matches
# against the raw payload and still fails SAFE. Edit PROTECTED for your branches.
# ---------------------------------------------------------------------------
set -uo pipefail

PROTECTED="main|master|dev|develop"
# A protected name appearing as a standalone ref token (bounded by space, colon,
# quote, or line end) — so 'origin main' / 'HEAD:dev' match, but a feature branch
# like 'feature/main-refactor' does not.
PROT_TOK="(^|[[:space:]]|:|\")(${PROTECTED})([[:space:]]|:|\"|\$)"

input="$(cat)"
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
else
  cmd="$input"   # fallback: match the raw payload (fails safe, not open)
fi
[ -z "$cmd" ] && { printf '{}'; exit 0; }

deny() {
  local r="$1"; r="${r//\\/\\\\}"; r="${r//\"/\\\"}"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$r"
  exit 0
}
has() { printf '%s' "$cmd" | grep -Eq "$1"; }

# 1) Any force-push.
if has 'git[[:space:]]+push([[:space:]]|\")' && has '(--force|--force-with-lease|[[:space:]]-f([[:space:]]|\"))'; then
  deny "BLOCKED: force-push is not permitted (history protection)."
fi

# 2) DELETION PROTECTION for main/master/dev/develop — UNCONDITIONAL.
#    Holds even if these branches are not protected by any GitHub ruleset.
if has 'git[[:space:]]+push([[:space:]]|\")' && has '(--delete|[[:space:]]-d([[:space:]]|\"))' && has "$PROT_TOK"; then
  deny "BLOCKED: main/dev (and master/develop) must never be deleted — even when unprotected."
fi
if has 'git[[:space:]]+push([[:space:]]|\")' && has ":(refs/heads/)?(${PROTECTED})([[:space:]]|\"|\$)"; then
  deny "BLOCKED: main/dev must never be deleted — even when unprotected."
fi
if has 'git[[:space:]]+branch[[:space:]]+-[dD]([[:space:]]|\")' && has "$PROT_TOK"; then
  deny "BLOCKED: main/dev must never be deleted — even when unprotected."
fi
if has "git[[:space:]]+update-ref[[:space:]]+-d[[:space:]]+refs/heads/(${PROTECTED})([[:space:]]|\"|\$)"; then
  deny "BLOCKED: main/dev must never be deleted — even when unprotected."
fi
if has 'gh[[:space:]]+api([[:space:]]|\")' && has '(-X[[:space:]]+DELETE|--method[[:space:]]+DELETE)' && has "refs/heads/(${PROTECTED})([[:space:]]|\"|\$)"; then
  deny "BLOCKED: main/dev must never be deleted — even when unprotected."
fi

# 3) Direct push to a protected branch — merges must go through a PR.
if has 'git[[:space:]]+push([[:space:]]|\")' && has "$PROT_TOK"; then
  deny "BLOCKED: no direct push to a protected branch (${PROTECTED}). Open a PR and merge it (after chat confirmation)."
fi

# 4) Switching to a protected branch — the agent works only in feature worktrees.
if has 'git[[:space:]]+(checkout|switch)([[:space:]]|\")' && has "$PROT_TOK"; then
  deny "BLOCKED: do not switch to a protected branch. Work inside a feature worktree; merge via 'gh pr merge'."
fi

# NOTE: 'gh pr merge' is deliberately allowed. The merge gate is your explicit
# confirmation in chat — see CLAUDE.orchestration.md / /task-merge.
printf '{}'
exit 0
