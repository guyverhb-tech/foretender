#!/usr/bin/env bash
# SessionStart
#
# A pipeline run outlives a session. Without this, resuming means re-reading
# six artifacts to work out where things stand — or worse, silently restarting
# a phase that already completed.
#
# Injects a short status block so the session picks up mid-run.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

harness_require_active

H="$HARNESS_DIR"
PHASE="$(harness_phase)"; ROUND="$(harness_round)"; TASK="$(harness_task)"

status_of() {
  local f="$1" label="$2"
  [ -f "$f" ] || return 0
  local s; s="$(verdict_field "$f" status)"
  if [ -n "$s" ]; then printf -- '- %s: `%s` — **%s**\n' "$label" "${f#"${CLAUDE_PROJECT_DIR:-$PWD}"/}" "$s"
  else printf -- '- %s: `%s`\n' "$label" "${f#"${CLAUDE_PROJECT_DIR:-$PWD}"/}"; fi
}

MSG="## Build harness — run in progress

**Task:** ${TASK:-unnamed}
**Phase:** \`${PHASE:-unknown}\`  **Round:** ${ROUND:-1}

### Artifacts on disk
$(status_of "$H/brief.md" Brief)$(status_of "$H/scout.md" Scout)$(status_of "$H/plan.md" Plan)$(status_of "$H/plan-critique.md" "Plan critique")$(status_of "$H/build-log.md" Build)$(status_of "$H/review.md" Review)$(status_of "$H/worklist.md" Worklist)$(status_of "$H/revision-log.md" Revision)$(status_of "$H/qa-report.md" QA)$(status_of "$H/handoff.md" Handoff)

Phase gates are active: source edits are restricted by \`.harness/state.json\` → \`phase\`.
Run \`/build-pipeline resume\` to continue, or set \`active: false\` in state.json to work outside the pipeline."

if [ -n "$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" status --porcelain 2>/dev/null)" ]; then
  MSG="$MSG

**Note:** the working tree is dirty. Confirm those changes belong to this run before continuing."
fi

emit_context SessionStart "$MSG"
