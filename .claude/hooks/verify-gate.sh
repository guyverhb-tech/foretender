#!/usr/bin/env bash
# Stop
#
# The turn cannot end with the tree broken. Runs the project's verification
# commands and blocks the stop if any of them fail.
#
# This is the highest-value hook in the harness, because it converts "I believe
# this works" into "this demonstrably builds and passes". It is also the most
# dangerous one to get wrong: a gate that can't be satisfied traps the session,
# so it gives up after `max_stop_attempts` and lets the turn end with a warning.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

harness_require_active
[ "$(cfg verify_gate true)" = "true" ] || exit 0

INPUT="$(cat)"
# The attempt counter below already bounds this, but bail early when another
# Stop hook is mid-continuation so the two can't compound.
[ "$(json_get "$INPUT" stop_hook_active)" = "true" ] && [ "$(cfg verify_on_continuation false)" != "true" ] && exit 0

PHASE="$(harness_phase)"
case "$PHASE" in
  # Nothing has been built yet, or the tree is deliberately red.
  brief|scout|research|plan|plan-review|test) exit 0 ;;
esac

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$ROOT" 2>/dev/null || exit 0

ATTEMPTS_FILE="$HARNESS_DIR/.stop-attempts"
MAX="$(cfg max_stop_attempts 3)"
ATTEMPTS=0
[ -f "$ATTEMPTS_FILE" ] && ATTEMPTS="$(cat "$ATTEMPTS_FILE" 2>/dev/null || echo 0)"

# --- Resolve the commands to run -------------------------------------------
# Explicit config wins; otherwise infer from the project.
resolve() {
  local key="$1" script="$2"
  local v; v="$(cfg "verify.$key" "")"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  has_script "$script" && pm_run "$script"
}

CMDS=()
[ -n "$(resolve typecheck typecheck)" ] && CMDS+=("typecheck|$(resolve typecheck typecheck)")
[ -n "$(resolve lint lint)" ]           && CMDS+=("lint|$(resolve lint lint)")
[ -n "$(resolve test test)" ]           && CMDS+=("test|$(resolve test test)")
[ -n "$(resolve build build)" ]         && CMDS+=("build|$(resolve build build)")

# Non-node fallbacks when nothing was configured or found.
if [ ${#CMDS[@]} -eq 0 ]; then
  if [ -f "$ROOT/go.mod" ]; then
    CMDS+=("build|go build ./..." "test|go test ./...")
  elif [ -f "$ROOT/Cargo.toml" ]; then
    CMDS+=("check|cargo check" "test|cargo test")
  elif [ -f "$ROOT/pyproject.toml" ] && command -v pytest >/dev/null 2>&1; then
    CMDS+=("test|pytest -q")
  elif [ -f "$ROOT/Makefile" ] && grep -q '^test:' "$ROOT/Makefile" 2>/dev/null; then
    CMDS+=("test|make test")
  fi
fi

[ ${#CMDS[@]} -eq 0 ] && exit 0   # Nothing to verify — don't invent a gate.

# --- Run --------------------------------------------------------------------
FAILED=""
TIMEOUT="$(cfg verify_timeout 300)"

for entry in "${CMDS[@]}"; do
  name="${entry%%|*}"; cmd="${entry#*|}"
  if ! OUTPUT="$(run_capped "$TIMEOUT" bash -lc "$cmd" 2>&1)"; then
    FAILED="${FAILED}### ${name} — \`${cmd}\` failed
\`\`\`
$(printf '%s' "$OUTPUT" | tail -40)
\`\`\`
"
  fi
done

if [ -z "$FAILED" ]; then
  rm -f "$ATTEMPTS_FILE"
  exit 0
fi

# --- Failed -----------------------------------------------------------------
ATTEMPTS=$((ATTEMPTS + 1))
printf '%s' "$ATTEMPTS" > "$ATTEMPTS_FILE"

if ! enforcing; then
  printf 'HARNESS (advisory): verification is failing.\n\n%s' "$FAILED" >&2
  exit 0
fi

if [ "$ATTEMPTS" -ge "$MAX" ]; then
  # Escalate to the human rather than trapping the session in a loop.
  rm -f "$ATTEMPTS_FILE"
  cat <<EOF
{"systemMessage":"Harness: verification still failing after $MAX attempts — letting the turn end so you can look. See .harness/verify-failure.md."}
EOF
  { printf '# Verification failure — %s\n\nStill failing after %s attempts.\n\n' "$(date +%F\ %T)" "$MAX"
    printf '%s\n' "$FAILED"; } > "$HARNESS_DIR/verify-failure.md"
  exit 0
fi

printf 'HARNESS: the tree does not verify, so this turn cannot end (attempt %s/%s).\n\n%s\nFix these, then finish. Do not weaken or skip a test to get green.\n' \
  "$ATTEMPTS" "$MAX" "$FAILED" >&2
exit 2
