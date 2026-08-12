#!/usr/bin/env bash
# PreToolUse: Edit|Write|NotebookEdit|Bash
#
# Blocks the small set of actions that are expensive or impossible to undo:
# writing secrets, rewriting history, force-pushing, hard-resetting over
# uncommitted work, and recursive deletes outside the project.
#
# UNCONDITIONAL, unlike every other hook here. It does not check
# `active` and it does not honour `enforcement: advisory` for the hard rules
# below — those guardrails are about the repository, not about the pipeline, and
# a destructive command is no less destructive between runs. The `protected`
# globs from config.json are the one part that does respect `enforcement`.
#
# Deliberately narrow. A hook that blocks routine work gets disabled within a
# day, and then it protects nothing.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

INPUT="$(cat)"
TOOL="$(json_get "$INPUT" tool_name)"

# --- File writes -----------------------------------------------------------
case "$TOOL" in
  Bash|PowerShell) ;;   # falls through to the command section below
  *)
    FILE="$(hook_target_path "$INPUT")"
    [ -n "$FILE" ] || exit 0
    BASE="$(basename "$FILE")"

    case "$BASE" in
      # Templates and examples are checked into the repo on purpose and contain
      # no real values. Blocking them is the classic false positive that gets
      # the whole hook switched off.
      .env.example|.env.sample|.env.template|.env.dist|.env.defaults|*.pem.example)
        ;;
      .env|.env.*|*.env|*.pem|*.key|*.p12|*.pfx|id_rsa|id_ed25519|credentials|.npmrc|.netrc)
        printf 'HARNESS: refusing to write "%s". Secrets and credential files are off limits to the pipeline.\nIf this genuinely needs to change, do it yourself outside the harness.\n' "$BASE" >&2
        exit 2
        ;;
    esac

    case "$FILE" in
      */.git/*) printf 'HARNESS: refusing to write inside .git/. Use git commands.\n' >&2; exit 2 ;;
    esac

    # Additional globs from .harness/config.json -> protected: ["docs/api.md", ...]
    # `set -f` matters: without it the shell pathname-expands the pattern list
    # against the cwd, so "src/*" silently becomes the files that exist right
    # now and anything created later isn't protected at all.
    set -f
    for pat in $(cfg protected ""); do
      set +f
      # shellcheck disable=SC2254
      case "${FILE#"${CLAUDE_PROJECT_DIR:-$PWD}"/}" in
        $pat) deny "'$FILE' matches a protected path ($pat) in .harness/config.json." ;;
      esac
      set -f
    done
    set +f

    exit 0
    ;;
esac

# --- Bash ------------------------------------------------------------------
CMD="$(json_get "$INPUT" tool_input.command)"
[ -n "$CMD" ] || exit 0

# Collapse whitespace so spacing tricks don't slip past the patterns.
NORM="$(printf '%s' "$CMD" | tr '\n' ' ' | tr -s ' ')"

block() { printf 'HARNESS: blocked — %s\nCommand: %s\n' "$1" "$CMD" >&2; exit 2; }

case "$NORM" in
  *"rm -rf /"*|*"rm -rf /*"*|*"rm -rf ~"*|*"rm -fr /"*)
    block "recursive delete of a root or home path" ;;
  *"git push"*--force*|*"git push"*" -f "*|*"git push --force-with-lease"*)
    # Force-push is legitimate on a feature branch and catastrophic on a shared one.
    BR="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    case "$BR" in
      main|master|develop|release*|prod|production)
        block "force-push to '$BR'. Push to a feature branch and open a PR." ;;
    esac
    ;;
  *"git reset --hard"*|*"git checkout -- ."*|*"git clean -"*fd*|*"git restore ."*)
    if [ -n "$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" status --porcelain 2>/dev/null)" ]; then
      block "this discards uncommitted changes and the tree is dirty. Commit or stash first, or run it yourself."
    fi
    ;;
  *"git filter-branch"*|*"git filter-repo"*|*"git rebase"*-i*|*"git commit"*--amend*)
    BR="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    case "$BR" in
      main|master) block "history rewrite on '$BR'." ;;
    esac
    ;;
  *"chmod -R 777"*|*"chmod 777"*)
    block "world-writable permissions" ;;
  *"curl"*"| sh"*|*"curl"*"| bash"*|*"wget"*"| sh"*|*"wget"*"| bash"*)
    block "piping a downloaded script straight into a shell. Download it, read it, then run it." ;;
  *" > .env"*|*">> .env"*|*"tee .env"*)
    block "writing to .env" ;;
esac

# Harness-only rules below this point.
harness_require_active

case "$NORM" in
  *"npm test"*--force*|*"jest"*--u*|*"vitest"*-u*|*"snapshot"*--update*)
    warn "updating snapshots wholesale hides regressions. Update the specific snapshot and say why in the log." ;;
esac

exit 0
