#!/usr/bin/env bash
# PreToolUse: Edit|Write|NotebookEdit
#
# Enforces the pipeline's phase discipline: no source code before an approved
# plan. This is the hook that makes the harness real. Without it "plan first"
# is a request in a prompt, and prompts get skipped under time pressure.
#
# Writes to .harness/ are always allowed — that's how the pipeline records
# itself, and blocking them would deadlock the run.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

harness_require_active
[ "$(cfg phase_gate true)" = "true" ] || exit 0

INPUT="$(cat)"
FILE="$(hook_target_path "$INPUT")"
if [ -z "$FILE" ]; then
  # The matcher fired but no path could be extracted — a tool shape we don't
  # know. Say so rather than silently allowing; a new write-tool must not open
  # a hole in the gate just because this script hasn't heard of it.
  warn "phase-gate could not determine a target path for tool '$(json_get "$INPUT" tool_name)'. \
Gate not applied — treat the phase restriction as still in force."
fi

# The pipeline's own artifacts are never gated.
is_harness_path "$FILE" && exit 0

PHASE="$(harness_phase)"

case "$PHASE" in
  build|revise|integrate|done)
    exit 0
    ;;

  test)
    # test-author phase: tests only, so the implementation can't be smuggled in
    # under a test-writing mandate.
    is_test_path "$FILE" && exit 0
    deny "phase is 'test' — only test files may be written right now. \
'$FILE' is not a test path. Move to the build phase before editing implementation, \
or write this under the project's test directory."
    ;;

  brief|scout|research)
    deny "phase is '$PHASE' — no source edits before a plan exists. \
Write .harness/brief.md and run the planner first. \
(To work outside the pipeline, set active=false in .harness/state.json.)"
    ;;

  plan|plan-review)
    deny "phase is '$PHASE' — the plan is still under review, so source is frozen. \
Get .harness/plan-critique.md to 'status: APPROVED', then advance state.json to phase 'build'."
    ;;

  review|adjudicate)
    deny "phase is '$PHASE' — the diff is under review and must not move while critics read it. \
Wait for .harness/worklist.md, then advance to phase 'revise'. \
Reviewers report; they do not fix."
    ;;

  qa)
    deny "phase is 'qa' — QA is verifying this exact tree. Editing now invalidates the report. \
If QA found a defect, advance to phase 'revise' with the defect on the worklist."
    ;;

  *)
    # Unknown phase: don't invent policy, let it through.
    exit 0
    ;;
esac
