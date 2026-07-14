#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# wt.sh — git worktree lifecycle for isolated agent work.
#
# Every task gets its own worktree + feature branch, cut from a CLEAN base.
# The agent never touches your primary checkout or your uncommitted work.
#
#   wt.sh inventory            Show the full state before starting (do this first).
#   wt.sh new <slug> [base]    Create ../<repo>-worktrees/<slug> on branch
#                              feature/<slug>, based on origin/<base> (default: dev).
#   wt.sh list                 List existing worktrees.
#   wt.sh prune <slug>         Remove the worktree (branch is kept unless --branch).
#
# Worktrees are placed in a SIBLING folder so they never nest inside the repo.
# ---------------------------------------------------------------------------
set -euo pipefail

PROTECTED_RE='^(main|master|dev|develop)$'
ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$ROOT")"
WT_DIR="$(dirname "$ROOT")/${REPO_NAME}-worktrees"

cmd="${1:-inventory}"; shift || true

inventory () {
  echo "== Worktrees ==";        git worktree list
  echo; echo "== Local branches =="; git branch -vv
  echo; echo "== Stashes ==";     git stash list || true
  echo; echo "== Working tree status (primary checkout) =="; git -C "$ROOT" status -s || true
  echo; echo "== Open pull requests =="; gh pr list --state open 2>/dev/null || echo "(gh not available / not authenticated)"
  echo; echo "== Recent commits on dev =="; git log --oneline -8 origin/dev 2>/dev/null || true
}

new () {
  local slug="${1:?usage: wt.sh new <slug> [base]}"
  local base="${2:-dev}"
  local branch="feature/${slug}"
  local path="${WT_DIR}/${slug}"

  echo ">> Fetching origin ..."; git fetch --quiet origin
  echo ">> Inventory before creating the worktree:"; echo; inventory; echo
  echo ">> Creating worktree '${path}' on '${branch}' from 'origin/${base}' ..."
  mkdir -p "$WT_DIR"
  git worktree add -b "$branch" "$path" "origin/${base}"

  # Attribute commits in this worktree to the agent identity, if configured.
  if [ -n "${AGENT_GIT_NAME:-}" ] && [ -n "${AGENT_GIT_EMAIL:-}" ]; then
    git -C "$path" config user.name  "$AGENT_GIT_NAME"
    git -C "$path" config user.email "$AGENT_GIT_EMAIL"
    echo "  ↳ commits here attributed to: ${AGENT_GIT_NAME} <${AGENT_GIT_EMAIL}>"
  else
    echo "  ! AGENT_GIT_NAME / AGENT_GIT_EMAIL not set — commits will use your global identity."
  fi

  echo "✓ Ready. cd \"${path}\"  and start Claude Code there."
}

list () { git worktree list; }

prune () {
  local slug="${1:?usage: wt.sh prune <slug> [--branch]}"
  local path="${WT_DIR}/${slug}"
  local branch="feature/${slug}"
  git worktree remove "$path"
  echo "✓ Removed worktree ${path}"
  if [ "${2:-}" = "--branch" ]; then
    if [[ "$branch" =~ $PROTECTED_RE ]]; then
      echo "Refusing to delete protected branch ${branch}"; exit 1
    fi
    git branch -D "$branch" && echo "✓ Deleted branch ${branch}"
  fi
}

case "$cmd" in
  inventory) inventory ;;
  new)       new "$@" ;;
  list)      list ;;
  prune)     prune "$@" ;;
  *) echo "Unknown command: ${cmd}"; echo "Try: inventory | new | list | prune"; exit 1 ;;
esac
