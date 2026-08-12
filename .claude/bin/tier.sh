#!/usr/bin/env bash
# Recommend a pipeline tier for a change, from signals rather than from vibes.
#
#   .claude/bin/tier.sh --paths "src/a.ts src/b.ts"   # before the work exists
#   .claude/bin/tier.sh --from-plan                   # from .harness/plan.md
#   .claude/bin/tier.sh --from-diff                   # from the working tree
#   .claude/bin/tier.sh                               # diff, then plan, then give up
#
# Prints a score, the tier, and every signal that contributed — the reasoning is
# the point. A tier recommendation nobody can audit is just a coin flip with
# extra steps, and it has to be arguable for an override to mean anything.
#
# Exit code is the tier (0-3), so a caller can branch on it directly.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../hooks/lib/harness.sh
. "$DIR/../hooks/lib/harness.sh" 2>/dev/null || { echo "tier: cannot find hooks/lib/harness.sh" >&2; exit 2; }

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$ROOT" 2>/dev/null || exit 2

MODE=""; PATHS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --paths)     MODE=paths; PATHS="$2"; shift 2 ;;
    --from-plan) MODE=plan; shift ;;
    --from-diff) MODE=diff; shift ;;
    --json)      JSON=1; shift ;;
    *) shift ;;
  esac
done

# --- Collect the file list -------------------------------------------------
collect_diff() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  { git diff --name-only 2>/dev/null; git diff --cached --name-only 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null; } | sort -u | grep -v '^\.harness/'
}

collect_plan() {
  [ -f "$HARNESS_DIR/plan.md" ] || return 1
  # Backticked paths in the plan that look like files.
  grep -oE '`[^`]+\.[a-zA-Z0-9]+`' "$HARNESS_DIR/plan.md" 2>/dev/null \
    | tr -d '`' | grep -E '/|\.' | grep -vE '^https?:' | sed 's/:[0-9]*$//' | sort -u
}

case "$MODE" in
  paths) FILES="$(printf '%s\n' $PATHS | sort -u)" ;;
  plan)  FILES="$(collect_plan)" ;;
  diff)  FILES="$(collect_diff)" ;;
  *)     FILES="$(collect_diff)"; [ -z "$FILES" ] && FILES="$(collect_plan)" ;;
esac

SCORE=0; REASONS=""
add() { SCORE=$((SCORE + $1)); REASONS="${REASONS}  +$1  $2"$'\n'; }
nil() { REASONS="${REASONS}   0  $1"$'\n'; }

NFILES=0
[ -n "$FILES" ] && NFILES="$(printf '%s\n' "$FILES" | grep -c . )"

if [ "$NFILES" = 0 ]; then
  # No signal at all. Recommending "direct" here would be the dangerous default:
  # an unscoped change is exactly the one worth planning.
  cat <<EOF
tier: 2 (standard)
score: n/a — no file signal available

Nothing to measure: no working-tree changes and no plan with file paths.
Defaulting to standard rather than direct, because an unscoped change is the
one most likely to be bigger than it looks. Re-run with --from-plan once the
plan exists, or pass --paths "a.ts b.ts" if you already know the surface.
EOF
  exit 2
fi

# --- Blast radius ----------------------------------------------------------
if   [ "$NFILES" -le 1 ]; then nil "blast radius: 1 file"
elif [ "$NFILES" -le 3 ]; then add 8  "blast radius: $NFILES files"
elif [ "$NFILES" -le 8 ]; then add 18 "blast radius: $NFILES files"
else                           add 30 "blast radius: $NFILES files"
fi

# --- Sensitive surface -----------------------------------------------------
SENS="$(printf '%s\n' "$FILES" | grep -iE '(^|/)(auth|session|login|signup|token|jwt|password|crypt|secret|payment|billing|checkout|stripe|invoice|permission|role|acl|admin|middleware)([./_-]|$)' | head -4)"
if [ -n "$SENS" ]; then
  add 25 "security-sensitive paths: $(printf '%s' "$SENS" | tr '\n' ' ')"
else nil "no security-sensitive paths"; fi

# --- Persisted shape / migrations -----------------------------------------
MIG="$(printf '%s\n' "$FILES" | grep -iE '(migration|schema\.prisma|\.sql$|/drizzle/|/models?/|entities?/)' | head -3)"
if [ -n "$MIG" ]; then
  add 20 "touches persisted shape: $(printf '%s' "$MIG" | tr '\n' ' ')"
else nil "no schema or migration files"; fi

# --- Public interface ------------------------------------------------------
IFACE="$(printf '%s\n' "$FILES" | grep -iE '(^|/)(index\.[jt]sx?|api/|routes?/|openapi|\.proto$|public-api|package\.json)' | head -3)"
if [ -n "$IFACE" ]; then
  add 12 "touches a public interface: $(printf '%s' "$IFACE" | tr '\n' ' ')"
else nil "no public interface files"; fi

# --- Test coverage of the touched area ------------------------------------
HAS_TESTS=0
if git ls-files 2>/dev/null | grep -qE '(\.test\.|\.spec\.|_test\.|/tests?/|/spec/)'; then HAS_TESTS=1; fi
if [ "$HAS_TESTS" = 0 ]; then
  add 10 "repo has no test suite — nothing catches a regression but review"
else
  COVERED=0
  for f in $FILES; do
    b="$(basename "$f" | sed 's/\.[^.]*$//')"
    [ -n "$b" ] || continue
    if git ls-files 2>/dev/null | grep -E '(\.test\.|\.spec\.|_test\.|/tests?/|/spec/)' | grep -qi "$b"; then COVERED=1; break; fi
  done
  if [ "$COVERED" = 1 ]; then nil "tests exist for the touched area"
  else add 12 "tests exist in the repo but none appear to cover these files"; fi
fi

# --- Stakes: does anyone depend on this? ----------------------------------
DEPLOYS=0
for m in vercel.json vercel.ts .vercel Dockerfile fly.toml netlify.toml .github/workflows; do
  [ -e "$ROOT/$m" ] && DEPLOYS=1 && break
done
if [ "$DEPLOYS" = 1 ]; then add 12 "repo deploys — a bad change reaches users"
else nil "no deploy config — not user-facing yet"; fi

COMMITS="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
if   [ "$COMMITS" -gt 100 ]; then add 8 "mature repo ($COMMITS commits) — more to regress"
elif [ "$COMMITS" -gt 30 ];  then add 4 "established repo ($COMMITS commits)"
else nil "young repo ($COMMITS commits) — little to break"; fi

# --- Change kind -----------------------------------------------------------
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # `git diff HEAD` sees nothing for an untracked manifest, which is exactly the
  # case where every dependency in it is new.
  DEPDIFF="$(git diff HEAD -- package.json 2>/dev/null)"
  if [ -z "$DEPDIFF" ] && [ -f package.json ] && \
     ! git ls-files --error-unmatch package.json >/dev/null 2>&1; then
    DEPDIFF="$(sed 's/^/+/' package.json 2>/dev/null)"
  fi
  if printf '%s' "$DEPDIFF" | grep -qE '^\+.*"[^"]+"[[:space:]]*:[[:space:]]*"[\^~0-9]'; then
    add 10 "adds a dependency — new third-party code in the build"
  fi
  # `grep -c` exits 1 on no match, so a `|| echo 0` fallback would append a
  # second line and make the comparison below a syntax error.
  DEL="$(git diff HEAD --diff-filter=D --name-only 2>/dev/null | grep -c . )"
  [ -n "$DEL" ] || DEL=0
  [ "$DEL" -gt 0 ] && add 8 "deletes $DEL file(s) — removal is harder to review than addition"
fi

# --- Decide ----------------------------------------------------------------
T1="$(cfg tier_thresholds.quick 15)"
T2="$(cfg tier_thresholds.standard 35)"
T3="$(cfg tier_thresholds.full 60)"

if   [ "$SCORE" -ge "$T3" ]; then TIER=3; NAME="full";     AGENTS="scout, planner, plan-critic, test-author, builder, 4-lens panel, verifiers, adjudicator, reviser, qa, integrator"
elif [ "$SCORE" -ge "$T2" ]; then TIER=2; NAME="standard"; AGENTS="scout, planner, plan-critic, builder, code-critic, verifiers, reviser, qa"
elif [ "$SCORE" -ge "$T1" ]; then TIER=1; NAME="quick";    AGENTS="builder (inline plan), code-critic, verifiers"
else                              TIER=0; NAME="direct";   AGENTS="none — work directly, hooks still guard"
fi

if [ "${JSON:-0}" = 1 ]; then
  printf '{"tier":%s,"name":"%s","score":%s,"files":%s}\n' "$TIER" "$NAME" "$SCORE" "$NFILES"
  exit "$TIER"
fi

cat <<EOF
tier: $TIER ($NAME)
score: $SCORE   files: $NFILES

signals:
$REASONS
roster: $AGENTS

thresholds: direct <$T1 | quick $T1-$((T2-1)) | standard $T2-$((T3-1)) | full >=$T3
override anytime: /build-pipeline --tier N <task>
EOF
exit "$TIER"
