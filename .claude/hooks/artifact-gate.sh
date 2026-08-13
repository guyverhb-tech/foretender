#!/usr/bin/env bash
# SubagentStop
#
# Every pipeline agent owes an artifact with a parseable VERDICT block. An agent
# that returns a nice summary and writes nothing breaks the chain silently —
# the next agent reads a missing file and improvises. Blocking here forces the
# agent to finish its actual job before it's allowed to stop.
#
# NOTE: SubagentStop does NOT fire for Agent-tool (Task) subagent spawns — only
# for `claude --agent` CLI subagents (verified 2026-08-13; see .harness/decisions.md).
# The build-pipeline orchestrator spawns via the Agent tool, so in that path this
# hook never runs; the orchestrator calls bin/advance-phase.sh after each agent
# instead. Both share the validate+advance logic in lib/harness.sh, so they can't
# drift. This hook stays for the CLI-subagent path and as defence in depth.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

harness_require_active
[ "$(cfg artifact_gate true)" = "true" ] || exit 0

INPUT="$(cat)"
AGENT="$(json_get "$INPUT" agent_type)"
[ -n "$AGENT" ] || exit 0

# Already continuing because this hook blocked once. Re-denying just burns turns
# against the continuation cap: if the agent couldn't produce the artifact on the
# retry, it won't. Let it stop and leave the gap for the orchestrator to see.
[ "$(json_get "$INPUT" stop_hook_active)" = "true" ] && exit 0

# Validate the artifact; deny (block the stop) if it's missing/empty/verdict-less.
REASON="$(harness_artifact_reason "$AGENT")" || deny "$REASON"

# Artifact is valid — advance the phase (no-op for verdict/research/unknown agents
# and for a lens before the panel is complete).
harness_do_advance "$AGENT"
exit 0
