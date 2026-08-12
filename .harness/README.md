# `.harness/`

Working directory for the build pipeline. Agents hand work to each other through
the files in here — **artifacts, not conversation**. Each agent writes its output
to disk and the orchestrator passes paths, so nothing important survives only as
a summary-of-a-summary.

Start a run with `/build-pipeline <what you want built>`.

## The master switch

`state.json` → `"active": false` makes the pipeline hooks inert. The gates only
apply while a run is in progress; ordinary work in this repo is unaffected.

One exception, by design: `protect-paths.sh` keeps blocking writes to secrets and
`.git/`, and keeps blocking destructive shell commands, whether or not a run is
active — those are about the repository, not the pipeline. Its configurable
`protected` globs do follow the switch.

## Files

| File | Written by | Contract |
| --- | --- | --- |
| `config.json` | you | Enforcement settings. Committed. |
| `state.json` | orchestrator | Current phase and round. Hooks read this. Not committed. |
| `brief.md` | orchestrator | Scope contract from the intake Q&A. **Authoritative** — every downstream agent is bound by it. |
| `scout.md` | scout | Map of the territory: what exists, what depends on what, what the conventions are. |
| `research/*.md` | researcher | Verified answers to external unknowns. |
| `plan.md` | planner | The implementation plan. |
| `plan-critique.md` | plan-critic | Adversarial review of the plan. Carries a VERDICT. |
| `test-plan.md` | test-author | Tests derived from the brief, not from the code. |
| `build-log.md` | builder | What was done, deviations, deferred items, verification output. |
| `findings/*.md` | critic panel | One file per lens. Each carries a VERDICT. |
| `findings/verdicts/*.md` | finding-verifier | One per finding: CONFIRMED / REFUTED / UNCERTAIN. |
| `review.md` | code-critic | Single-critic mode alternative to the panel. |
| `worklist.md` | adjudicator | The deduplicated, verified, ranked list of what to fix. |
| `revision-log.md` | reviser | What was applied, what was blocked, regression check. |
| `qa-report.md` | qa | Observed behavior against the brief. Carries a VERDICT. |
| `integration-log.md` | integrator | The behavior-preserving cleanup pass. |
| `handoff.md` | reporter | PR description, review guide, commit message. |
| `decisions.md` | adjudicator | Append-only ledger of what was dropped, deferred, and resolved. |

## The VERDICT contract

Every artifact a gate depends on ends with a machine-readable block:

```
<!-- VERDICT
status: APPROVED
blocking: 0
major: 2
minor: 5
-->
```

It must be the last thing in the file. Hooks and the orchestrator parse it, which
is what makes the pipeline programmatic rather than a matter of reading tone.

`status` is one of `APPROVED`, `CHANGES_REQUIRED`, `PASS`, `PASS_WITH_ISSUES`,
`FAIL`, `SHIP`, `REVISE`, `REPLAN`. Verifier files use `result:` with
`CONFIRMED` / `REFUTED` / `UNCERTAIN`.

## `decisions.md` is the memory

It's the only file that persists across runs, and it's what stops round 3 from
relitigating round 1 — and run 20 from relitigating run 1. Critics are instructed
to read it before raising a finding. Keep it.

## Committing

Commit `config.json`, `README.md`, and `decisions.md`. Ignore the rest:

```gitignore
.harness/*
!.harness/config.json
!.harness/README.md
!.harness/decisions.md
```
