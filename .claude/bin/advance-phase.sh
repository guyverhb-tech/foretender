#!/usr/bin/env bash
# advance-phase.sh <agent_type>
#
# The orchestrator's replacement for the SubagentStop artifact-gate. SubagentStop
# does NOT fire for Agent-tool (Task) subagent spawns — verified 2026-08-13; the
# hook's capture never ran for a matching `scout` spawn — so the build-pipeline
# skill, which spawns every agent via the Agent tool, can't rely on the hook to
# validate artifacts and advance the phase. It calls this after each agent lands.
#
# Same guarantee as the hook, same code path (lib/harness.sh): it validates the
# agent's artifact BEFORE advancing, so it can never move the pipeline forward
# through a missing or verdict-less artifact.
#
#   Exit 0 — artifact valid; phase advanced (or intentionally held: a lens before
#            the panel completes, finding-verifier/researcher, or no successor).
#            Prints "HARNESS: phase X -> Y (after <agent>)" to stderr on a move.
#   Exit 3 — artifact missing/empty/verdict-less. Prints the reason. The
#            orchestrator must NOT advance; re-dispatch the agent to finish it.
#   Exit 2 — usage / harness not active.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../hooks/lib/harness.sh
. "$DIR/../hooks/lib/harness.sh"

AGENT="${1:-}"
[ -n "$AGENT" ] || { echo "usage: advance-phase.sh <agent_type>" >&2; exit 2; }

if ! harness_active; then
  echo "advance-phase.sh: harness is not active (.harness/state.json active:false) — nothing to advance" >&2
  exit 2
fi

# Validate first — identical checks to the SubagentStop gate.
if ! REASON="$(harness_artifact_reason "$AGENT")"; then
  printf 'HARNESS: %s\n' "$REASON" >&2
  exit 3
fi

# Artifact valid — advance (respects the panel barrier, reviser round bump, and
# the auto_advance config switch).
harness_do_advance "$AGENT"
exit 0
