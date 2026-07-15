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
#
# KNOWN LIMITATION — it sees one string, not a parsed shell.
# It cannot tell a command from text that merely quotes one. A commit message or
# PR body that contains an example of a blocked command (in a heredoc or an
# inline -m) will trip it. This is deliberate: really parsing shell would be more
# fragile than the guardrail is worth, and failing safe is the right default.
# Workaround: pass prose via a file — `git commit -F msg.txt`, `gh pr create
# --body-file body.md` — so the command string stays free of quoted commands.
#
# Run ./test-guardrails.sh after ANY change here. It is ~40 lines of regex
# guarding the one thing that cannot be undone; it can regress silently.
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

# Judge each shell segment SEPARATELY. Real commands are chained, and matching
# the whole string mixes them up: `git push origin feature/x && gh pr create
# --base dev` has a "git push" in one segment and a bare "dev" in another, which
# reads as a push to dev and gets denied. That false positive is not theoretical
# — it fired on the first real /task-finish. Splitting keeps every rule below
# exactly as strict per segment (a chained `... && git push origin main` still
# has "git push" and "main" in the SAME segment and is still blocked), it only
# stops the cross-segment mixing. Splitting on a `|` inside a quoted string just
# yields smaller segments, which can never turn a denial into an approval.
segments="$(printf '%s' "$cmd" | awk '{gsub(/&&|\|\||;|\|/, "\n"); print}')"

has() { printf '%s' "$seg" | grep -Eq "$1"; }

while IFS= read -r seg; do
  [ -z "${seg//[[:space:]]/}" ] && continue

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
done <<EOF
${segments}
EOF

# NOTE: 'gh pr merge' is deliberately allowed. The merge gate is your explicit
# confirmation in chat — see CLAUDE.orchestration.md / /task-merge.
printf '{}'
exit 0
