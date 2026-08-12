#!/usr/bin/env bash
# PostToolUse: Edit|Write|NotebookEdit
#
# Tight feedback loop: format and check the file that was just written, and
# hand any error straight back to the agent while the change is still in its
# head. Catching a type error here costs one turn; catching it at the Stop
# gate costs a whole re-read of the diff.
#
# PostToolUse can't block (the write already happened), so exit 2 here means
# "show this to Claude", which is exactly what's wanted.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/harness.sh
. "$DIR/lib/harness.sh"

harness_require_active
[ "$(cfg validate_on_write true)" = "true" ] || exit 0

INPUT="$(cat)"
FILE="$(hook_target_path "$INPUT")"
[ -n "$FILE" ] && [ -f "$FILE" ] || exit 0
is_harness_path "$FILE" && exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$ROOT" 2>/dev/null || exit 0
REL="${FILE#"$ROOT"/}"
OUT=""

note() { OUT="${OUT}$1"$'\n'; }

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
    # Format first — formatting noise in a later diff is pure cost.
    if [ -f "$ROOT/biome.json" ] || [ -f "$ROOT/biome.jsonc" ]; then
      npx --no-install biome check --write "$REL" >/dev/null 2>&1
    elif [ -f "$ROOT/.prettierrc" ] || [ -f "$ROOT/.prettierrc.json" ] || \
         [ -f "$ROOT/.prettierrc.js" ] || [ -f "$ROOT/prettier.config.js" ] || \
         grep -q '"prettier"' "$ROOT/package.json" 2>/dev/null; then
      npx --no-install prettier --write "$REL" >/dev/null 2>&1
    fi

    # ESLint on the single file. --no-install so a missing toolchain is a no-op
    # rather than a surprise network install mid-edit.
    if [ -f "$ROOT/eslint.config.js" ] || [ -f "$ROOT/eslint.config.mjs" ] || \
       [ -f "$ROOT/.eslintrc" ] || [ -f "$ROOT/.eslintrc.json" ] || [ -f "$ROOT/.eslintrc.js" ]; then
      L="$(run_capped 45 npx --no-install eslint "$REL" 2>&1)" || \
        note "eslint — $REL:"$'\n'"$L"
    fi

    # Typecheck is project-wide (tsc has no reliable single-file mode with
    # path aliases), so it's opt-out for big repos where it's slow.
    if [ "$(cfg typecheck_on_write true)" = "true" ] && [ -f "$ROOT/tsconfig.json" ]; then
      case "$FILE" in *.ts|*.tsx)
        T="$(run_capped 90 npx --no-install tsc --noEmit -p "$ROOT/tsconfig.json" 2>&1)" || {
          # Only surface errors in the file just touched; the rest is pre-existing noise.
          MINE="$(printf '%s' "$T" | grep -F "$REL" | head -20)"
          [ -n "$MINE" ] && note "tsc — errors in $REL:"$'\n'"$MINE"
        }
      ;; esac
    fi
    ;;

  *.py)
    if command -v ruff >/dev/null 2>&1; then
      ruff format "$REL" >/dev/null 2>&1
      L="$(run_capped 45 ruff check "$REL" 2>&1)" || note "ruff — $REL:"$'\n'"$L"
    elif command -v black >/dev/null 2>&1; then
      black -q "$REL" >/dev/null 2>&1
    fi
    if [ "$(cfg typecheck_on_write true)" = "true" ] && command -v mypy >/dev/null 2>&1; then
      M="$(run_capped 90 mypy "$REL" 2>&1)" || note "mypy — $REL:"$'\n'"$M"
    fi
    ;;

  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$REL" >/dev/null 2>&1
    V="$(run_capped 60 go vet "./$(dirname "$REL")" 2>&1)" || note "go vet:"$'\n'"$V"
    ;;

  *.rs)
    command -v rustfmt >/dev/null 2>&1 && rustfmt --edition 2021 "$REL" >/dev/null 2>&1
    ;;

  *.sh|*.bash)
    command -v shellcheck >/dev/null 2>&1 && {
      S="$(shellcheck -S warning "$REL" 2>&1)" || note "shellcheck — $REL:"$'\n'"$S"
    }
    ;;

  *.json)
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$REL" 2>/dev/null || \
        note "$REL is not valid JSON."
    fi
    ;;
esac

# Secrets that slipped into a normal source file.
if grep -nEi '(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*["'\''][A-Za-z0-9_\-]{16,}' "$FILE" 2>/dev/null | grep -qv 'process\.env\|os\.environ\|import\.meta\.env\|getenv'; then
  note "$REL looks like it contains a hardcoded credential. Move it to an environment variable."
fi

if [ -n "$OUT" ]; then
  printf 'HARNESS: issues in the file you just wrote — fix them now, while you have the context.\n\n%s' "$OUT" >&2
  exit 2
fi
exit 0
