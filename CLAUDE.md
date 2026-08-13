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
npm install
npm run build

# Fetch one Europe/London day (default: yesterday) into data/.
# Politely paced: >=13 s between requests, Retry-After honoured — a typical
# day is ~4-5 requests, so expect ~60-90 s. Re-running the same day is
# idempotent and reports "0 new releases".
node dist/cli/fetch-day.js [--day YYYY-MM-DD] [--store DIR]

# Back-fill a contiguous range of Europe/London days, oldest-first and
# resumably: an interrupted re-run over the same range skips days already
# marked complete (persisted in checkpoints.ndjson) and ingests only the rest.
# The range is INCLUSIVE of both endpoints; pacing carries across day
# boundaries, so a three-day catch-up is ~16 requests over a few minutes.
node dist/cli/backfill.js --from YYYY-MM-DD --to YYYY-MM-DD [--store DIR]

# Project an existing raw store's tender-tagged releases into a deterministic
# canonical model, rebuilding <store>/canonical.ndjson and anomalies.ndjson and
# printing a summary (regime split, anomaly count + rate, per-regime coverage).
# Offline: reads only existing raw data, makes no network requests.
node dist/cli/normalise.js [--store DIR]
```

Only the default `data/` store is gitignored (anchored to the repo root). A
non-default `--store DIR` writes raw API bodies and a journal carrying recorded
response headers — never commit those. Point `--store` at a path under `data/`
(e.g. `--store data/run2`) or another already-ignored location.

## Verify

```bash
npm run typecheck
npm test          # fixture-only contract tests; zero network by construction
npm run build
```

These are the commands the harness verify gate runs (mirrored in
`.harness/config.json`). There is no CI yet — a workflow is /ship's job, after
this slice. Keep them working — when one of them is broken or missing, every
automated check downstream quietly does less than it appears to.

## Layout

The ingest seam lives in `src/ingest/` — `window.ts` (London-day windows,
19-char local datetimes, plus `londonDayRange` for a backfill's day list),
`validate.ts` (identity-only validation), `ingest.ts` (the cursor-pagination
walk; all I/O injected), and `backfill.ts` (`runBackfill` — the resumable
multi-day loop over `ingestWindow`, gated by the store's day-completion
checkpoint; no new I/O). `src/store/` is the raw append-only store:
`raw-store.ts` (NDJSON journal + content-addressed body bytes under `data/raw/`,
plus the releases/quarantine/checkpoints projections) and `replay.ts`
(journal-backed transport that re-runs a recorded walk through `ingestWindow`
itself, scoped to one run — the newest, or an explicit `runId`, since the
append-only journal accumulates a run per recorded day). `src/cli/fetch-day.ts`
(one day) and `src/cli/backfill.ts` (a day range) are the thin live shells, both
wiring the shared live transport from `src/cli/live-deps.ts` — the only file
that touches global fetch. `src/normalise/` is the offline canonical projection —
`model.ts` (the canonical tender shape + anomaly types), `normalise.ts` (the pure
per-release normaliser, sibling to `validate.ts`), and `project.ts`
(`projectTenders` — the deterministic full rebuild of `canonical.ndjson`/
`anomalies.ndjson` over an existing raw store); `src/cli/normalise.ts`
(`node dist/cli/normalise.js [--store DIR]`) is its thin shell and touches no
network. Contract tests in `test/` replay the real
recorded pages committed under `test/fixtures/` (never edit those; see
`test/fixtures/README.md`). `data/` is the gitignored store.

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
