# Phase 2 kickoff — Breadth and durability

_The charter for Phase 2. Written 2026-08-14 at the close of Phase 1. This governs
Phase 2 the way `KICKOFF.md` governed Phase 0→1._

## 0. How to use this

**Read first, before any code:** `BUILD_BRIEF.md` (especially §2.1 the learning
goal, §5.3 deterministic replay, and the Phase 2 paragraph at §"Phase 2 — Breadth
and durability"), `KICKOFF.md`, `PHASE0_FINDINGS.md`, `PHASE1_INVARIANTS.md`, and
`.harness/decisions.md` (every slice-1→7 ruling — the append-only ledger is the
project's memory). Data-fact precedence is unchanged: `PHASE0_FINDINGS > KICKOFF §2
> BUILD_BRIEF §4`. `PHASE1_INVARIANTS.md` is still law. For Phase-2 scope conflicts,
this file is latest and wins.

**Phase 1 is DONE.** This session OPENS Phase 2. Do the Phase-2 review with Henry
(§5) and get the first slice's brief confirmed **before writing code** — same
discipline as the Phase 0 review. Then run each slice through `/build-pipeline`.

## 1. Where Phase 1 ended — the substrate you build on

The deterministic core AND the first agent are complete, committed as a stacked
branch chain off `main` (`0c5c9af`, slice 4):

- slices 1–4 (on `main`): whole-stream ingest, resumable backfill, tender→canonical
  normalisation, lifecycle state machine.
- slice 5 `40c5783`: baseline prediction + grading loop (deterministic, model-free).
- slice 6 `bcbb728`: per-ocid identity projection (title/buyer/value).
- slice 7 `1ad4db8`: **the first agent** — model predictor + a model-call ledger
  with zero-network journal replay.

Layers: `src/{ingest,store,normalise,lifecycle,prediction,grading,identity,model-predict}`.
CLIs: `fetch-day, backfill, normalise, lifecycle, scoreboard, identity, model-predict`.
234 fixture-only tests, zero runtime deps, zero network in tests.

**Load-bearing properties already established (Phase 2 extends these, does not
redo them):**
- Deterministic replay is real for BOTH network I/O (`src/store/{raw-store,replay}.ts`)
  and model calls (`src/model-predict/ledger.ts`): content-addressed journals,
  zero-network replay. This is §5.3 in the flesh — the foundation Phase 2's durability
  rests on.
- All I/O and model calls are INJECTED seams (`Transport`, `ModelClient`), with a
  mock/recorded path for tests and a live shell (`src/cli/live-deps.ts`, `live-model.ts`)
  as the only files touching the network/key. Clocks/timestamps are injected — no
  wall-clock anywhere.
- §5.4 dirty-reality anomalies are recorded, never crashed; anomaly rate is a health
  metric.
- No-leakage: predictors see only events ≤ a date cutoff (never release id).

**Branch state:** `5→6→7` are NOT merged or pushed (`main` is still at slice 4).
**First Phase-2 decision (see §5): merge/push the `4→5→6→7` stack to `main` so Phase 2
branches off a clean trunk (recommended), or keep stacking.**

Also on the table but NOT built: the repo-hosted scoreboard-**page generator** (a
private preview Artifact exists and renders real data with named procurements —
Henry liked it; it is not a committed slice). It is a secondary-goal Phase-1
leftover — do it early in Phase 2 or skip in favour of durability work (§5).

## 2. What Phase 2 is (BUILD_BRIEF §Phase 2 + §2.1)

**Breadth and durability.** The primary-goal learning — the reason the project
exists — is durable execution. Concretely:

- **Self-scheduled wake** — the durable loop. Thousands of procurements, each waking
  on external events at unpredictable intervals over 6–24-month lifespans.
- **Crash recovery and resume** — kill mid-flight, resume from the ledger with no
  double-acting and no lost work.
- **State migration while work is in flight** — change a persisted shape without
  losing in-flight procurement state.
- **Golden-set replay against recorded fixtures** — detect silent degradation when
  the underlying model changes beneath you.
- **Additional prediction-ladder rungs** — days (amendment/deadline), months
  (winner / final-vs-estimate), years (re-let). The weeks–months pipeline→tender
  rung is done (slices 5 + 7).
- **Cross-run append-only prediction accumulation** — deferred from slice 5's M1
  ruling: the prediction ledger becomes genuinely append-only across wakes
  (predictions accumulate over real time, keyed by `(ocid, madeAt, predictorVersion)`),
  not the single-`--asof` full-rebuild view Phase 1 built.

## 3. The load-bearing tension — durability WITHOUT deployment

`BUILD_BRIEF §8` puts deployment infrastructure (auth, multi-tenancy, a hosted
daemon/cron) OUT OF SCOPE. Yet Phase 2 is "long-running / self-scheduled." Resolve
this the way slices 1–7 resolved live I/O and model calls: **build the
durable-execution MACHINERY as deterministic, injected-clock, testable code — not a
deployed daemon.**

- The self-scheduled wake is a STATE MACHINE over the store: a durable work queue
  where each procurement carries a next-wake time and a durable position; a
  **resumable runner** processes due work (fetch new notices → reconstruct lifecycle
  → predict → grade → compute the next wake), appending every action to the ledger.
- The CLOCK and SCHEDULER are INJECTED (like `Transport`/`ModelClient`), so a
  6-month lifespan is exercised by advancing a virtual clock in a fixture test — no
  real time, no host.
- Crash recovery is tested by KILLING and RESUMING over fixtures: the ledger is the
  source of truth; a partial run resumes idempotently (no double-ingest, no
  double-predict, no double-grade). The raw-store dedupe and the ledger's
  content-addressing are the tools.
- Real continuous running (a host, cron, a daemon) stays DEFERRED (§8). What gets
  built and graded is the machinery + its replayable proof of durability.

If you find yourself wanting to deploy something to prove Phase 2, stop — the proof
is a killed-and-resumed run over a virtual timeline, in a test.

## 4. Suggested first slice + order (propose in the review; Henry confirms)

- **Slice 8 (recommended first) — the durable scheduler + resumable runner.** The
  self-scheduled-wake core: a per-ocid next-wake work queue over the store; a runner
  that processes due procurements end-to-end and is crash-resumable; injected
  clock/scheduler; a killed-and-resumed test proving no double-act / no loss; every
  action to the append-only ledger; a full replay reproduces identical state. This
  is the primary-goal heart and everything else in Phase 2 hangs off it.
- Then, roughly: crash-recovery hardening + a golden-set degradation check → the
  amendment/deadline **"days" prediction rung** (high-signal; the invariants already
  scoped it: `tenderUpdate` tag + a direction-aware deadline diff) → cross-run
  append-only prediction accumulation → state migration mid-lifecycle.
- **Phase 2 definition of done (propose + confirm):** a runner reconstructs,
  predicts, and grades the whole procurement population on a self-scheduled cadence
  over a virtual timeline; survives a mid-flight kill by resuming from the ledger
  with identical results; and a golden-set replay flags a deliberately-perturbed
  model output as degradation.

## 5. The Phase-2 review — genuine decisions Henry owns

Run a short review with Henry BEFORE slice 8 (analogous to the Phase 0 review). The
real decisions — the ones that change what gets built:

1. **Scheduling substrate.** Confirm the injected-clock / offline-machinery approach
   of §3 (build durability as testable code, defer real deployment) — recommended —
   versus standing up a real scheduler now (which reopens the §8 deployment
   decision).
2. **First prediction-ladder rung.** Recommend amendment/deadline ("days"): highest
   frequency, already scoped by the invariants, and it exercises the update path the
   lifecycle already models.
3. **Merge/push the `4→5→6→7` stack to `main`** before Phase 2 so slices branch off a
   clean trunk (recommended yes) — or keep stacking.
4. **Golden-set scope** — which recorded fixtures (raw-store pages + model-call
   ledger entries) become the degradation golden set.
5. **The scoreboard-page generator** (Phase-1 leftover) — build it early in Phase 2,
   or skip and stay on durability?

## 6. Harness protocol (unchanged from Phase 1 — do not relearn the hard way)

- Every substantial slice runs through `/build-pipeline`, tier-scored first
  (`.claude/bin/tier.sh`). Supervised main-session (the intake needs `AskUserQuestion`).
- **KNOWN HARNESS FAULT:** `SubagentStop` does NOT fire for Agent-tool (Task) subagent
  spawns. The orchestrator drives phases by calling `.claude/bin/advance-phase.sh
  <agent_type>` after each agent lands, and reads the ARTIFACT's `VERDICT` block (not
  the agent's chat reply) to gate. Never advance through a missing/failed artifact.
- Read the artifact, not the reply. Verify load-bearing claims independently before
  advancing. Fail loud on unmapped shapes. Zero runtime deps. Match the surrounding
  code's conventions. Clear stale `.harness/findings/*` between review rounds (a
  stale artifact masquerading as the current round is a real trap — it has bitten
  before).
- The unattended/overnight runner fails fast (can't hang for input) and lacks the
  subagent tool, so semantic slices run supervised.
- `.harness/decisions.md` is the durable ledger — read it, append to it, don't
  relitigate what it settles.

## 7. Watch-items specific to Phase 2

- **Idempotent resume is the whole game.** A resumed runner must not double-ingest,
  double-predict, or double-grade. Design each step to be a pure function of
  (durable state + new input), checkpointed to the ledger before its effect is
  observable.
- **Keep non-determinism at the edges.** Model calls are non-deterministic even at
  temperature 0; the record/replay ledger already quarantines that. The scheduler,
  runner, and grading stay deterministic and replayable — the golden set depends on it.
- **State migration is the hardest problem here.** Version the persisted shapes;
  migrate without losing in-flight lifecycle state; test a migration applied to a
  procurement mid-lifecycle.
- **Silent degradation is the failure mode the golden set exists to catch** — a green
  suite that has quietly stopped exercising what it appears to. Make the golden-set
  check assert on recorded model outputs, and make a perturbation fail it loudly.

---

_Status at handoff: Phase 1 complete (slices 1–7). `5→6→7` committed, not pushed/merged.
234 tests green, zero deps, zero network. This file is uncommitted in the working tree —
committing it (and deciding decision §5.3) is the first act of Phase 2._
