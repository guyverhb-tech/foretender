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

**Read `BUILD_BRIEF.md` and `KICKOFF.md` in full before any work. Where they
conflict, KICKOFF.md wins (it is later). Phase gates and scope limits live
there, not here.**

## Stack

- Not yet chosen — deliberately (KICKOFF §1.4). A runtime recommendation is due
  at the Phase 0 findings review; do not resolve this silently.
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
- Anything marked ASSUMED in the briefs is unverified. Phase 0 closes the list;
  pipeline-notice volume is the named kill-risk — if it's rare, stop and
  escalate, don't adapt (brief §4, §7).

---

Personal defaults — how I work, the shipping bar, git conventions — live in
`~/.claude/CLAUDE.md` and apply here automatically. This file is only for what's
specific to foretender.
