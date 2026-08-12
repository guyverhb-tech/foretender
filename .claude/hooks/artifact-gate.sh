#!/usr/bin/env bash
# SubagentStop
#
# Every pipeline agent owes an artifact with a parseable VERDICT block. An agent
# that returns a nice summary and writes nothing breaks the chain silently —
# the next agent reads a missing file and improvises.
#
# Blocking here forces the agent to finish its actual job before it's allowed
# to stop, which is much cheaper than discovering the gap two phases later.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

harness_require_active
[ "$(cfg artifact_gate true)" = "true" ] || exit 0

INPUT="$(cat)"
AGENT="$(json_get "$INPUT" agent_type)"
[ -n "$AGENT" ] || exit 0

# Already continuing because this hook blocked once. Re-denying just burns turns
# against the 8-consecutive-continuation cap: if the agent couldn't produce the
# artifact on the retry, it isn't going to. Let it stop and leave the missing
# artifact for the orchestrator to see.
[ "$(json_get "$INPUT" stop_hook_active)" = "true" ] && exit 0

H="$HARNESS_DIR"

# artifact + whether a VERDICT block is required
case "$AGENT" in
  scout)              REQ="$H/scout.md";            NEEDS_VERDICT=0 ;;
  planner)            REQ="$H/plan.md";             NEEDS_VERDICT=0 ;;
  plan-critic)        REQ="$H/plan-critique.md";    NEEDS_VERDICT=1 ;;
  test-author)        REQ="$H/test-plan.md";        NEEDS_VERDICT=0 ;;
  builder)            REQ="$H/build-log.md";        NEEDS_VERDICT=0 ;;
  code-critic)        REQ="$H/review.md";           NEEDS_VERDICT=1 ;;
  critic-correctness) REQ="$H/findings/correctness.md"; NEEDS_VERDICT=1 ;;
  critic-integration) REQ="$H/findings/integration.md"; NEEDS_VERDICT=1 ;;
  critic-security)    REQ="$H/findings/security.md";    NEEDS_VERDICT=1 ;;
  critic-simplicity)  REQ="$H/findings/simplicity.md";  NEEDS_VERDICT=1 ;;
  adjudicator)        REQ="$H/worklist.md";         NEEDS_VERDICT=1 ;;
  reviser)            REQ="$H/revision-log.md";     NEEDS_VERDICT=0 ;;
  qa)                 REQ="$H/qa-report.md";        NEEDS_VERDICT=1 ;;
  integrator)         REQ="$H/integration-log.md";  NEEDS_VERDICT=0 ;;
  reporter)           REQ="$H/handoff.md";          NEEDS_VERDICT=0 ;;
  finding-verifier)
    # One verdict file per finding, named for the finding ID, so the exact name
    # isn't knowable here. Require a *recent* verdict-bearing file rather than
    # just a non-empty directory — otherwise one leftover file from an earlier
    # round satisfies the gate for every verifier that follows.
    fresh_artifact_in "$H/findings/verdicts" 1 && exit 0
    deny "finding-verifier finished without writing a fresh verdict to \
.harness/findings/verdicts/<FINDING-ID>.md. Write the file named for the finding you were assigned, \
ending with a VERDICT block whose 'result:' is CONFIRMED, REFUTED, or UNCERTAIN."
    ;;

  researcher)
    # Topic-named, same problem, same treatment.
    fresh_artifact_in "$H/research" 0 && exit 0
    deny "researcher finished without writing .harness/research/<topic>.md. \
The planner reads that file — a summary in the reply doesn't reach it."
    ;;
  *) exit 0 ;;   # Not a pipeline agent.
esac

if [ ! -f "$REQ" ]; then
  deny "$AGENT finished without writing ${REQ#"${CLAUDE_PROJECT_DIR:-$PWD}"/}. \
That file is the handoff to the next phase — a summary in the reply doesn't reach it. \
Write the artifact in the format your instructions specify, then finish."
fi

# Empty or stub file is the same failure with extra steps.
if [ "$(wc -c < "$REQ" 2>/dev/null || echo 0)" -lt 120 ]; then
  deny "$AGENT wrote ${REQ#"${CLAUDE_PROJECT_DIR:-$PWD}"/} but it is essentially empty. \
Write the real content in the structure your instructions specify."
fi

if [ "$NEEDS_VERDICT" = "1" ] && ! has_verdict "$REQ"; then
  deny "$AGENT wrote ${REQ#"${CLAUDE_PROJECT_DIR:-$PWD}"/} without a machine-readable VERDICT block. \
Append one as the last thing in the file, using the status values your own instructions specify \
(critics: APPROVED / CHANGES_REQUIRED — adjudicator: SHIP / REVISE / REPLAN — qa: PASS / \
PASS_WITH_ISSUES / FAIL):

<!-- VERDICT
status: <your value>
blocking: 0
major: 0
minor: 0
-->

The orchestrator and the gates parse this; without it the pipeline can't advance."
fi

# ---------------------------------------------------------------------------
# Phase auto-advance
#
# Reached only once the artifact above passed every check, so this can never
# move the pipeline forward through a failed gate.
#
# Hand-maintaining `phase` was the most error-prone step in a run: a stale value
# either blocks legitimate work or opens a gate that should be shut. Where the
# next phase isn't unambiguous, this leaves it alone for the orchestrator.
#
# `finding-verifier` and `researcher` return earlier and never reach this: the
# orchestrator knows how many of each it spawned in parallel, and this hook
# can't.
# ---------------------------------------------------------------------------
[ "$(cfg auto_advance true)" = "true" ] || exit 0

PHASE="$(harness_phase)"
STATUS="$(verdict_field "$REQ" status)"
ROSTER=" $(harness_roster) "
NEXT=""

rostered() { case "$ROSTER" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# The panel runs in parallel, so the first lens to finish must not advance the
# phase out from under the others. Advance only once every rostered lens has
# landed a verdict-bearing findings file.
panel_complete() {
  local lens f
  for lens in correctness integration security simplicity; do
    if rostered "critic-$lens"; then
      f="$H/findings/$lens.md"
      { [ -f "$f" ] && has_verdict "$f"; } || return 1
    fi
  done
  return 0
}

case "$AGENT" in
  scout)
    if   rostered researcher;  then NEXT="research"
    else                            NEXT="plan"; fi ;;
  planner)            NEXT="plan-review" ;;
  plan-critic)
    case "$STATUS" in
      APPROVED)         rostered test-author && NEXT="test" || NEXT="build" ;;
      CHANGES_REQUIRED) NEXT="plan" ;;
    esac ;;
  test-author)        NEXT="build" ;;
  builder)            NEXT="review" ;;
  critic-correctness|critic-integration|critic-security|critic-simplicity)
    panel_complete && NEXT="adjudicate" ;;
  code-critic)
    # Single-critic mode: no adjudicator, so its own verdict drives the loop.
    case "$STATUS" in
      APPROVED)         NEXT="qa" ;;
      CHANGES_REQUIRED) NEXT="revise" ;;
    esac ;;
  adjudicator)
    case "$STATUS" in
      SHIP)   NEXT="qa" ;;
      REVISE) NEXT="revise" ;;
      REPLAN) NEXT="plan" ;;
    esac ;;
  reviser)            NEXT="review" ;;
  qa)
    case "$STATUS" in
      PASS|PASS_WITH_ISSUES) rostered integrator && NEXT="integrate" || NEXT="done" ;;
      FAIL)                  NEXT="revise" ;;
    esac ;;
  integrator)         NEXT="done" ;;
esac

if [ -n "$NEXT" ] && [ "$NEXT" != "$PHASE" ]; then
  if state_set phase "$NEXT"; then
    if [ "$AGENT" = "reviser" ]; then
      # A fresh review round starts here. Bump the counter the budget checks,
      # and clear last round's verdicts so they can't be read as this round's.
      R="$(harness_round)"; state_set round "$(( ${R:-1} + 1 ))"
      rm -f "$H"/findings/verdicts/*.md 2>/dev/null
    fi
    printf 'HARNESS: phase %s -> %s (after %s%s)\n' \
      "$PHASE" "$NEXT" "$AGENT" "${STATUS:+, $STATUS}" >&2
  fi
fi

exit 0
