#!/usr/bin/env bash
# Shared helpers for harness hooks.
#
# Every hook sources this and calls `harness_require_active` early: when the
# project has no .harness/ directory the hooks must be completely inert, so the
# same settings.json can live in a repo that isn't running the pipeline.
#
# Sourced, not executed. No `set -e` — a hook that dies mid-parse should fall
# through to "allow", never take the session down with it.

HARNESS_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/.harness"
HARNESS_STATE="$HARNESS_DIR/state.json"
HARNESS_CONFIG="$HARNESS_DIR/config.json"

# --- JSON ------------------------------------------------------------------
# json_get <json-string> <dotted.path> -> value on stdout, empty if absent.
# Tries jq, then python3, then node. Returns empty rather than failing so a
# machine without any of them degrades to permissive instead of broken.
json_get() {
  local blob="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$blob" | jq -r --arg p "$path" '
      (try getpath($p | split(".")) catch null) as $v
      | if $v == null then "" elif ($v|type) == "array" then ($v | join(" ")) else ($v|tostring) end
    ' 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$blob" | HK_PATH="$path" python3 -c '
import json,os,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for k in os.environ["HK_PATH"].split("."):
    if isinstance(d,dict) and k in d: d=d[k]
    else: sys.exit(0)
if isinstance(d,(list,tuple)): print(" ".join(str(x) for x in d))
elif isinstance(d,bool): print("true" if d else "false")
elif d is not None: print(d)
' 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$blob" | HK_PATH="$path" node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  let d;try{d=JSON.parse(s)}catch{return};
  for(const k of process.env.HK_PATH.split(".")){ if(d&&typeof d==="object"&&k in d)d=d[k];else return }
  if(Array.isArray(d))console.log(d.join(" "));else if(d!=null)console.log(d);
});' 2>/dev/null
  fi
}

json_file_get() { [ -f "$1" ] && json_get "$(cat "$1" 2>/dev/null)" "$2"; }

# --- Harness state ---------------------------------------------------------
harness_active() { [ -f "$HARNESS_STATE" ] && [ "$(json_file_get "$HARNESS_STATE" active)" = "true" ]; }

# Exit 0 (allow, silently) unless the harness is running in this project.
harness_require_active() { harness_active || exit 0; }

harness_phase() { json_file_get "$HARNESS_STATE" phase; }
harness_round() { json_file_get "$HARNESS_STATE" round; }
harness_task()  { json_file_get "$HARNESS_STATE" task; }
harness_roster() { json_file_get "$HARNESS_STATE" roster; }

# state_set <key> <value> — writes a string, or a bare number when the value is
# all digits. Read-modify-write, so it preserves the orchestrator's other keys.
state_set() {
  [ -f "$HARNESS_STATE" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    HK_K="$1" HK_V="$2" HK_F="$HARNESS_STATE" python3 - <<'PY'
import json,os
f=os.environ["HK_F"]; k=os.environ["HK_K"]; v=os.environ["HK_V"]
try: d=json.load(open(f))
except Exception: raise SystemExit(1)
d[k]=int(v) if v.isdigit() else v
json.dump(d, open(f,"w"), indent=2)
PY
  elif command -v node >/dev/null 2>&1; then
    HK_K="$1" HK_V="$2" HK_F="$HARNESS_STATE" node -e '
const fs=require("fs"), f=process.env.HK_F, k=process.env.HK_K, v=process.env.HK_V;
let d; try { d=JSON.parse(fs.readFileSync(f,"utf8")) } catch { process.exit(1) }
d[k] = /^\d+$/.test(v) ? Number(v) : v;
fs.writeFileSync(f, JSON.stringify(d,null,2));'
  else
    return 1
  fi
}

# cfg <key> <default>
cfg() {
  local v; v="$(json_file_get "$HARNESS_CONFIG" "$1")"
  [ -n "$v" ] && printf '%s' "$v" || printf '%s' "$2"
}

# True when hooks should block rather than warn.
enforcing() { [ "$(cfg enforcement blocking)" = "blocking" ]; }

# --- Hook responses --------------------------------------------------------
# Blocks in blocking mode; warns and allows in advisory mode. Exit 2 sends
# stderr to Claude and (for blockable events) stops the action.
deny() {
  if enforcing; then
    printf 'HARNESS: %s\n' "$1" >&2
    exit 2
  fi
  printf 'HARNESS (advisory): %s\n' "$1" >&2
  exit 0
}

# Non-blocking note back to Claude.
warn() { printf 'HARNESS: %s\n' "$1" >&2; exit 0; }

# Inject text into Claude's context without blocking anything.
emit_context() {
  local ev="$1" text="$2"
  if command -v python3 >/dev/null 2>&1; then
    HK_EV="$ev" HK_TXT="$text" python3 -c '
import json,os
print(json.dumps({"hookSpecificOutput":{"hookEventName":os.environ["HK_EV"],
                                        "additionalContext":os.environ["HK_TXT"]}}))'
  elif command -v node >/dev/null 2>&1; then
    HK_EV="$ev" HK_TXT="$text" node -e '
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:process.env.HK_EV,
                                                additionalContext:process.env.HK_TXT}}))'
  else
    # No JSON writer available: stderr with exit 0 still reaches the transcript.
    printf 'HARNESS: %s\n' "$text" >&2
  fi
  exit 0
}

# --- Paths -----------------------------------------------------------------
# The tool a write arrives on decides which key holds the path: Edit/Write use
# tool_input.file_path, NotebookEdit uses tool_input.notebook_path. Reading only
# the first silently exempts every notebook edit from every gate.
hook_target_path() {
  local p; p="$(json_get "$1" tool_input.file_path)"
  [ -n "$p" ] || p="$(json_get "$1" tool_input.notebook_path)"
  printf '%s' "$p"
}

# Path is inside .harness/ — the pipeline's own scratch space, always writable.
is_harness_path() { case "${1#"${CLAUDE_PROJECT_DIR:-$PWD}"/}" in .harness/*|*/.harness/*) return 0 ;; *) return 1 ;; esac }

# Overridable from config: `"test_paths": ["src/**/*.rs", "spec/*"]` for repos
# whose tests don't live in a conventional directory (Rust in-file `#[test]`
# modules, RSpec, etc). Without this the `test` phase deadlocks in those repos.
is_test_path() {
  local rel="${1#"${CLAUDE_PROJECT_DIR:-$PWD}"/}" pat
  case "$1" in
    *.test.*|*.spec.*|*_test.*|*test_*.py|*_spec.*|\
    */tests/*|*/test/*|*/__tests__/*|*/spec/*|*/e2e/*|*/cypress/*|*/testdata/*) return 0 ;;
  esac
  # `set -f` so the configured patterns aren't pathname-expanded into the
  # concrete files that happen to exist right now.
  set -f
  for pat in $(cfg test_paths ""); do
    # shellcheck disable=SC2254
    case "$rel" in $pat) set +f; return 0 ;; esac
  done
  set +f
  return 1
}

# --- Verdict blocks --------------------------------------------------------
# Agents end their artifacts with:
#   <!-- VERDICT
#   status: APPROVED
#   -->
# verdict_field <file> <field>
verdict_field() {
  [ -f "$1" ] || return 1
  awk -v want="$2" '
    /<!--[[:space:]]*VERDICT/ { inv=1; next }
    inv && /-->/ { inv=0 }
    inv {
      line=$0
      sub(/^[[:space:]]+/,"",line)
      split(line, kv, ":")
      key=kv[1]
      if (key == want) { val=substr(line, index(line,":")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",val); print val; exit }
    }
  ' "$1"
}

has_verdict() { [ -n "$(verdict_field "$1" status)" ] || [ -n "$(verdict_field "$1" result)" ]; }

# --- Freshness -------------------------------------------------------------
# Some agents write a file whose name isn't knowable in advance (one verdict per
# finding ID, one research file per topic). "The directory is non-empty" passes
# vacuously for every agent after the first, so instead require a *recent*
# substantive file. BSD and GNU stat disagree; try both.
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

newest_md_in() {
  local d="$1" newest="" nt=0 t f
  [ -d "$d" ] || return 1
  for f in "$d"/*.md; do
    [ -f "$f" ] || continue
    t="$(mtime "$f")"; [ -n "$t" ] || continue
    if [ "$t" -gt "$nt" ]; then nt="$t"; newest="$f"; fi
  done
  [ -n "$newest" ] && printf '%s' "$newest"
}

# fresh_artifact_in <dir> [require_verdict]
fresh_artifact_in() {
  local f age
  f="$(newest_md_in "$1")" || return 1
  [ -n "$f" ] || return 1
  age=$(( $(date +%s) - $(mtime "$f") ))
  [ "$age" -lt "$(cfg artifact_freshness 1800)" ] || return 1
  [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -ge 120 ] || return 1
  [ "${2:-0}" = "1" ] && { has_verdict "$f" || return 1; }
  return 0
}

# --- Artifact validation + phase advance -----------------------------------
# Shared by the SubagentStop hook (artifact-gate.sh, for `claude --agent` CLI
# subagents) AND by the orchestrator's bin/advance-phase.sh. The orchestrator
# path exists because SubagentStop does NOT fire for Agent-tool (Task) subagent
# spawns — verified empirically 2026-08-13 (a capture at the top of the hook
# never ran for a matching `scout` spawn), despite the docs claiming it should.
# Keeping the logic here means the two callers can never drift.

# harness_artifact_path <agent> -> canonical artifact path, or "" for agents
# whose artifact name isn't fixed (finding-verifier, researcher) or that owe none.
harness_artifact_path() {
  local H="$HARNESS_DIR"
  case "$1" in
    scout)              printf '%s' "$H/scout.md" ;;
    planner)            printf '%s' "$H/plan.md" ;;
    plan-critic)        printf '%s' "$H/plan-critique.md" ;;
    test-author)        printf '%s' "$H/test-plan.md" ;;
    builder)            printf '%s' "$H/build-log.md" ;;
    code-critic)        printf '%s' "$H/review.md" ;;
    critic-correctness) printf '%s' "$H/findings/correctness.md" ;;
    critic-integration) printf '%s' "$H/findings/integration.md" ;;
    critic-security)    printf '%s' "$H/findings/security.md" ;;
    critic-simplicity)  printf '%s' "$H/findings/simplicity.md" ;;
    adjudicator)        printf '%s' "$H/worklist.md" ;;
    reviser)            printf '%s' "$H/revision-log.md" ;;
    qa)                 printf '%s' "$H/qa-report.md" ;;
    integrator)         printf '%s' "$H/integration-log.md" ;;
    reporter)           printf '%s' "$H/handoff.md" ;;
    *)                  printf '' ;;
  esac
}

# Which artifacts must carry a machine-readable VERDICT block.
harness_needs_verdict() {
  case "$1" in
    plan-critic|code-critic|critic-correctness|critic-integration|critic-security|\
    critic-simplicity|adjudicator|qa) return 0 ;;
    *) return 1 ;;
  esac
}

# harness_artifact_reason <agent> — prints a human-actionable failure reason to
# stdout and returns 1 when the agent's artifact is missing/empty/verdict-less;
# returns 0 (silent) when the artifact is valid, when an unpredictably-named
# artifact (verdict/research) is freshly present, or when the agent owes none.
harness_artifact_reason() {
  local AGENT="$1" H="$HARNESS_DIR" REQ base f
  case "$AGENT" in
    integrator)
      # Canonical name is integration-log.md, but integrators have drifted to
      # integration-report.md in live runs; either satisfies the gate. Existence
      # + size only — harness_needs_verdict is false for the integrator.
      for f in "$H/integration-log.md" "$H/integration-report.md"; do
        [ -f "$f" ] && [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -ge 120 ] && return 0
      done
      printf '%s' "integrator finished without writing .harness/integration-log.md \
(or its accepted alias integration-report.md), or wrote it essentially empty. That file is the handoff to the next \
phase — a summary in the reply doesn't reach it. Write .harness/integration-log.md in the format your instructions \
specify, then finish."
      return 1 ;;
    finding-verifier)
      fresh_artifact_in "$H/findings/verdicts" 1 && return 0
      printf '%s' "finding-verifier finished without writing a fresh verdict to \
.harness/findings/verdicts/<FINDING-ID>.md. Write the file named for the finding you were assigned, \
ending with a VERDICT block whose 'result:' is CONFIRMED, REFUTED, or UNCERTAIN."
      return 1 ;;
    researcher)
      fresh_artifact_in "$H/research" 0 && return 0
      printf '%s' "researcher finished without writing .harness/research/<topic>.md. \
The planner reads that file — a summary in the reply doesn't reach it."
      return 1 ;;
  esac
  REQ="$(harness_artifact_path "$AGENT")"
  [ -n "$REQ" ] || return 0            # not a pipeline agent → nothing to check
  base="${REQ#"${CLAUDE_PROJECT_DIR:-$PWD}"/}"
  if [ ! -f "$REQ" ]; then
    printf '%s' "$AGENT finished without writing $base. That file is the handoff to the next phase — \
a summary in the reply doesn't reach it. Write the artifact in the format your instructions specify, then finish."
    return 1
  fi
  if [ "$(wc -c < "$REQ" 2>/dev/null || echo 0)" -lt 120 ]; then
    printf '%s' "$AGENT wrote $base but it is essentially empty. Write the real content in the structure your instructions specify."
    return 1
  fi
  if harness_needs_verdict "$AGENT" && ! has_verdict "$REQ"; then
    printf '%s' "$AGENT wrote $base without a machine-readable VERDICT block. Append one as the last thing in the file \
(critics: APPROVED / CHANGES_REQUIRED — adjudicator: SHIP / REVISE / REPLAN — qa: PASS / PASS_WITH_ISSUES / FAIL). \
The orchestrator and the gates parse this; without it the pipeline can't advance."
    return 1
  fi
  return 0
}

# rostered <agent> — is this agent in state.json's roster?
harness_rostered() { case " $(harness_roster) " in *" $1 "*) return 0 ;; *) return 1 ;; esac }

# The parallel critic panel: advance to adjudicate only once EVERY rostered lens
# has landed a verdict-bearing findings file, so the first to finish can't move
# the phase out from under the others.
harness_panel_complete() {
  local lens f H="$HARNESS_DIR"
  for lens in correctness integration security simplicity; do
    if harness_rostered "critic-$lens"; then
      f="$H/findings/$lens.md"
      { [ -f "$f" ] && has_verdict "$f"; } || return 1
    fi
  done
  return 0
}

# harness_next_phase <agent> — echoes the phase to advance to given the agent and
# its artifact's verdict, or "" when there is no unambiguous successor (a lens
# before the panel is complete; finding-verifier/researcher; unknown agent).
harness_next_phase() {
  local AGENT="$1" REQ STATUS
  REQ="$(harness_artifact_path "$AGENT")"
  [ -n "$REQ" ] && STATUS="$(verdict_field "$REQ" status)"
  case "$AGENT" in
    scout)   harness_rostered researcher && printf 'research' || printf 'plan' ;;
    planner) printf 'plan-review' ;;
    plan-critic)
      case "$STATUS" in
        APPROVED)         harness_rostered test-author && printf 'test' || printf 'build' ;;
        CHANGES_REQUIRED) printf 'plan' ;;
      esac ;;
    test-author) printf 'build' ;;
    builder)     printf 'review' ;;
    critic-correctness|critic-integration|critic-security|critic-simplicity)
      harness_panel_complete && printf 'adjudicate' ;;
    code-critic)
      case "$STATUS" in APPROVED) printf 'qa' ;; CHANGES_REQUIRED) printf 'revise' ;; esac ;;
    adjudicator)
      case "$STATUS" in SHIP) printf 'qa' ;; REVISE) printf 'revise' ;; REPLAN) printf 'plan' ;; esac ;;
    reviser) printf 'review' ;;
    qa)
      case "$STATUS" in
        PASS|PASS_WITH_ISSUES) harness_rostered integrator && printf 'integrate' || printf 'done' ;;
        FAIL)                  printf 'revise' ;;
      esac ;;
    integrator) printf 'done' ;;
  esac
}

# harness_do_advance <agent> — compute + apply the next phase, print the
# transition to stderr, handle the reviser's round bump + verdict clear. No-op if
# auto_advance is off or there's no unambiguous next phase. Reached only after
# harness_artifact_reason returned 0, so it can't advance through a failed gate.
harness_do_advance() {
  local AGENT="$1" H="$HARNESS_DIR" PHASE NEXT R
  [ "$(cfg auto_advance true)" = "true" ] || return 0
  PHASE="$(harness_phase)"
  NEXT="$(harness_next_phase "$AGENT")"
  [ -n "$NEXT" ] && [ "$NEXT" != "$PHASE" ] || return 0
  state_set phase "$NEXT" || return 1
  if [ "$AGENT" = "reviser" ]; then
    R="$(harness_round)"; state_set round "$(( ${R:-1} + 1 ))"
    rm -f "$H"/findings/verdicts/*.md 2>/dev/null
  fi
  printf 'HARNESS: phase %s -> %s (after %s)\n' "$PHASE" "$NEXT" "$AGENT" >&2
  return 0
}

# --- Stack detection -------------------------------------------------------
# Cheap and cached. Used to pick per-file validators when config doesn't say.
detect_pm() {
  local r="${CLAUDE_PROJECT_DIR:-$PWD}"
  [ -f "$r/pnpm-lock.yaml" ] && { echo pnpm; return; }
  [ -f "$r/yarn.lock" ]      && { echo yarn; return; }
  [ -f "$r/bun.lockb" ] || [ -f "$r/bun.lock" ] && { echo bun; return; }
  [ -f "$r/package-lock.json" ] || [ -f "$r/package.json" ] && { echo npm; return; }
  echo none
}

# Does package.json declare this script?
has_script() {
  local pj="${CLAUDE_PROJECT_DIR:-$PWD}/package.json"
  [ -f "$pj" ] && grep -q "\"$1\"[[:space:]]*:" "$pj" 2>/dev/null
}

pm_run() {
  case "$(detect_pm)" in
    pnpm) echo "pnpm run $1" ;;
    yarn) echo "yarn $1" ;;
    bun)  echo "bun run $1" ;;
    npm)  echo "npm run --silent $1" ;;
    *)    echo "" ;;
  esac
}

# Run a command with a wall-clock cap so a hung dev server can't wedge a hook.
run_capped() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1;  then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else "$@"
  fi
}
