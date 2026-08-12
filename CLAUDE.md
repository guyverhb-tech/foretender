# foretender

Watches the UK public procurement notice stream (Find a Tender), maintains a
longitudinal model of every procurement it sees, and makes falsifiable,
automatically graded predictions about what each will do next.

## What this is

The unit of the system is the procurement, not the notice — each is a long-lived
object emitting notices over 6–24 months, which makes this a durable-execution
problem by design (that's the primary goal: learning to build long-running
autonomous agents; the supplier-facing product is secondary). Predictions are
recorded in advance with confidence and an expected resolution date, then graded
against subsequent published notices.

**Read `BUILD_BRIEF.md`, `KICKOFF.md`, `PHASE0_FINDINGS.md`, and
`PHASE1_INVARIANTS.md` before any work. Where the briefs conflict, KICKOFF.md
wins (it is later); on data facts the precedence is PHASE0_FINDINGS.md >
KICKOFF §2 > BUILD_BRIEF §4 (set at the Phase 0 review, 2026-08-12).
`PHASE1_INVARIANTS.md` is builder-facing law. Phase gates and scope limits
live in the briefs, not here.**

## Stack

- TypeScript on Node.js (LTS), strict mode — decided by Henry at the Phase 0
  review (2026-08-12), per the recommendation in `PHASE0_FINDINGS.md`.
- Data source: FTS OCDS release API only (OCDS 1.1.5 + OCP extensions).
- Deploy: none yet (brief §8 — no deployment infrastructure).

## Running it

```bash
# Nothing runs yet. Phase 0 is research, not code.
```

## Verify

```bash
# No verify commands yet — set these when the runtime is chosen, and mirror
# them in .harness/config.json and CI at that point.
```

These are the commands the harness gate and CI both run. Keep them working — when
one of them is broken or missing, every automated check downstream quietly does
less than it appears to.

## Layout

<Fill in once there's structure worth describing. Where the interesting code
lives, not a directory listing.>

## Conventions

<Only what isn't obvious from reading the code. Delete this section rather than
padding it — a convention nobody follows is worse than none.>

## Decisions worth not re-litigating

- The unit is the procurement, not the notice. Do not flatten the model into a
  notice table (brief §3).
- Deterministic core, agents at the edges: ingest/store/lifecycle/grading are
  ordinary code; only prediction and generation touch models (brief §5.2).
- The ledger and deterministic replay are built from the first commit, not
  retrofitted (brief §5.3).
- Lifecycle state derives locally from the release stream; the
  `ocdsRecordPackages` endpoint is not depended on (KICKOFF §2).
- Anything marked ASSUMED in the briefs is unverified. Phase 0 closed the list
  (PHASE0_FINDINGS.md, 2026-08-12): kill-risk GO — Act-regime planning notices
  run ~222/week.
- Ingestion is whole-stream only. The API's `stages=` filter silently excludes
  the entire Act regime and all update/amendment tags (PHASE0_FINDINGS,
  independently verified). Never use `stages=` where completeness matters.
- Data-fact precedence: PHASE0_FINDINGS.md > KICKOFF §2 > BUILD_BRIEF §4.

---

Personal defaults — how I work, the shipping bar, git conventions — live in
`~/.claude/CLAUDE.md` and apply here automatically. This file is only for what's
specific to foretender.
