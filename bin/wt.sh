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
#   wt.sh prep <slug>          Make the worktree runnable: link .env* from the
#                              primary checkout, then install dependencies.
#   wt.sh list                 List existing worktrees.
#   wt.sh prune <slug>         Remove the worktree (branch is kept unless --branch).
#
# Worktrees are placed in a SIBLING folder so they never nest inside the repo.
# Two consequences that will bite you if you don't know them:
#   - A sibling worktree is "outside the project" for anything that sandboxes to a
#     project root. Codex started from the repo rejects EVERY write into it
#     ("patch rejected: writing outside of the project") — start it from inside
#     the worktree instead.
#   - The worktree has no node_modules and no .env* (both gitignored). Symlinking
#     node_modules is enough for jest but Turbopack refuses it ("points out of the
#     filesystem root"), so a dev server needs a real install -> `wt.sh prep`.
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

  cat <<EOF

✓ Worktree ready:  ${path}
   branch:         ${branch}   (from origin/${base})

  Your primary checkout (${ROOT}) is untouched and still on its own branch —
  it will show NO changes from this task. That is intended, not a bug.

  Look at it:   cursor "${path}"      # or: code "${path}"
  Run it:       bin/wt.sh prep ${slug}   # links .env*, installs deps
                then start the dev server on a NON-default port — your own
                server on the default port serves the base branch, i.e. the
                code WITHOUT this task's changes.
  Work on it:   cd "${path}" && run /task there.
                Tools that sandbox to a project root (Codex) must be started
                from inside this directory, not from the repo.
EOF
}

prep () {
  local slug="${1:?usage: wt.sh prep <slug>}"
  local path="${WT_DIR}/${slug}"
  [ -d "$path" ] || { echo "No worktree at ${path}. Run: wt.sh new ${slug}"; exit 1; }

  # .env* are gitignored, so a fresh worktree has none. Link (don't copy) so
  # secrets keep exactly one home and stay in sync.
  local linked=0
  for f in "$ROOT"/.env "$ROOT"/.env.local "$ROOT"/.env.development.local; do
    [ -f "$f" ] || continue
    ln -sfn "$f" "${path}/$(basename "$f")" && linked=$((linked + 1))
  done
  echo "✓ Linked ${linked} env file(s) from the primary checkout"

  # A symlinked node_modules is fine for jest but Turbopack rejects it, so the
  # worktree needs its own real install.
  if [ -d "${path}/node_modules" ] && [ ! -L "${path}/node_modules" ]; then
    echo "✓ node_modules already present"
  else
    rm -f "${path}/node_modules"
    echo ">> Installing dependencies in the worktree (this is not a symlink — Turbopack needs a real tree) ..."
    ( cd "$path" && { npm ci || npm install; } )
  fi

  echo "✓ ${path} is runnable. Start the dev server on a non-default port, e.g.:"
  echo "    cd \"${path}\" && npx next dev -p 3555"
  echo "  next dev also prints a Network URL (http://<lan-ip>:3555) — use it to test a mobile-only bug on a real phone."
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
  prep)      prep "$@" ;;
  list)      list ;;
  prune)     prune "$@" ;;
  *) echo "Unknown command: ${cmd}"; echo "Try: inventory | new | prep | list | prune"; exit 1 ;;
esac
