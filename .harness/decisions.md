# Decisions ledger

Append-only. The adjudicator writes here; critics read it before raising a finding.

This is the only file in `.harness/` that persists across runs, and it's the reason round 3 doesn't
relitigate round 1 — and run 20 doesn't relitigate run 1. **Commit it.**

Prune it occasionally: the value is in the recent, still-relevant entries. An entry whose code no
longer exists is just noise.

Format:

```markdown
## Round <N> — <YYYY-MM-DD>
- **<FINDING-ID> — <title>** — DROPPED (refuted): <reason> — do not re-raise without <what would change it>
- **<FINDING-ID> — <title>** — DEFERRED: out of scope per brief §<x> — tracked in <where>
- **<ID-A> vs <ID-B>** — RESOLVED in favor of <ID-A>: <reason>
- **<decision>** — ACCEPTED: <the deliberate choice, and why it looks wrong but isn't>
```

---

## Phase 0 review — 2026-08-12
- **Phase 0 findings** — ACCEPTED (conditional pass by Henry): nine review conditions folded into PHASE0_FINDINGS.md, KICKOFF.md, CLAUDE.md, PHASE1_INVARIANTS.md, and FTS_DEFECT_REPORT.md; all closed same day, reconciliations verified against the raw corpus.
- **Runtime: TypeScript on Node.js (LTS), strict** — ACCEPTED: Henry's call at review, per the findings' recommendation. KICKOFF §1.4 satisfied — not resolved silently.
- **Data-fact precedence: PHASE0_FINDINGS.md > KICKOFF §2 > BUILD_BRIEF §4** — ACCEPTED: set by Henry at review.
- **OD-1: prediction population (noticeType-segmented vs UK3-only)** — DEFERRED: named open decision for the Phase 1 plan; do not resolve silently. Input: 29-ocid multi-type progression cohort (0/29 in-window conversions).
- **KICKOFF Step 4 "one UTC day" → "one Europe/London day"** — ACCEPTED: corrected per proven window semantics (api-mechanics.md; FTS windows are Europe/London local).
- **Do not build predictions on bids.statistics** — ACCEPTED: 12.2% of Act-regime award volume and falling; annotation added to findings.

## Harness faults — 2026-08-12 (validation run, KICKOFF §4 log)
- **SubagentStop artifact-gate did not fire for a background-spawned planner** — BYPASSED: phase advanced brief→plan-review by hand after verifying .harness/plan.md on disk. Hypothesis: SubagentStop hooks don't run for async/background Agent spawns. Next agent spawned foreground to test. Harness fix batched, not interleaved (KICKOFF §4).
- **Auto-advance also absent on foreground plan-critic spawn** — BYPASSED: gate fired neither for background nor foreground Agent spawns; orchestrator drives state.json phase transitions by hand for the remainder of this run. Same batched-fix item.
- **Plan APPROVED round 2 with 1 MAJOR outstanding (M1: runId/at/epochMs untested)** — ACCEPTED: critic ruled it non-blocking with a two-assertion fix; delegated to test-author as binding addendum instead of a third plan round. N1 (frozen store snapshot is load-bearing) recorded for the simplicity critic.

## Round 1 adjudication — 2026-08-12 (Phase 1 slice 1, review round 1)
- **Verdicts applied: 9 findings verified, 9 CONFIRMED, 0 refuted, 0 uncertain.** I-M1 escalated by its verifier to BLOCKING (§5.3 replay can only replay the first run of a multi-run store). All 25 MINOR findings are unverified (no verdict file) and therefore capped at MINOR; none blocks. Outcome: REVISE, 13 worklist items covering 27 findings.
- **C-m3 vs S-M1/S-M3** — MERGED into S-M1 (links.next type + origin) and S-M3 (walk bounds): same code at `ingest.ts:199`, same fixes. C-m3 is an alias, not extra work.
- **C-m5 vs I-M1** — MERGED into I-M1: both are "replay cannot select a run". C-m5's second half (the divergence error mis-reports the cause as data corruption) is carried into I-M1's fix direction as an error-message requirement.
- **C-m6 vs S-M2** — MERGED into S-M2: identical (`Retry-After` has no ceiling). S-M2's verified TIMEOUT_MAX→1 ms clamp is the sharper half and is what the fix must close.
- **I-m6 vs C-M5** — MERGED into C-M5: same root (`window.ts` validates shape, not calendar). I-m6's live-seam cost (a wasted request against a ~12/120 s budget + an undeletable `run-end {ok:false}`) is carried into C-M5's failure case.
- **S-m1 (redirect: follow) folded into S-M1** — RESOLVED in favour of the one-line `redirect: 'manual'` over widening `TransportResponse` with `response.url`: a 30x otherwise bypasses S-M1's origin pin *after* the check, but three transports and their tests implement that response shape, so changing the seam is out of proportion to the fix. A 3xx now falls through the existing `status !== 200` path and fails loudly, journaled.
- **S-m4 (deep-nesting JSON.stringify RangeError) — IN SCOPE, folded into C-M4** — judged, not deferred: the crash half is already fixed by C-M2's run-end bracketing, and the residual (a record that is neither quarantined nor recorded) contradicts brief req 6's "nothing is silently discarded". The fix is a try/catch plus a bodyHash-reference fallback at the exact call site C-M4 rewrites.
- **S-m5, S-m6, Q-m2, C-m1, S-m2, Q-m4, Q-m3 — FOLDED** into the major items whose fixes touch the same lines. Rule applied: fold a cheap minor only where a major fix already opens that code; otherwise defer.
- **S-m7 — 4.7 MB of real notices (~150 procurement-officer emails, 31 phone numbers) in a PUBLIC repo** — DEFERRED to Henry, deliberately NOT given to the reviser. It is a decision, not a defect: OGL-licensed public-register data, so not a leak, but a conscious republication of personal contact data outside its original context. The reviser must not delete or redact fixtures — brief req 7 requires them committed whole and unedited and the contract tests depend on the exact bytes. Options for Henry before /ship: accept + note it in `test/fixtures/README.md`; make the repo private; or re-scope the fixture set (which reopens brief req 7 and the test-plan, i.e. a planning decision).
- **S-m3 — store `existsSync`/`wx` TOCTOU** — DEFERRED to backlog: the `wx` flag already defeats the symlink case; the residual needs local write access on a single-operator machine and the concurrency half presupposes scheduling, which the brief puts out of scope. Do not re-raise without a multi-writer store or a shared host.
- **S-m8 — no header allowlist on the append-only journal** — DEFERRED to backlog with a hard trigger: do it before any authenticated or cookie-bearing request is ever added, because the store has no rewrite path. Speculative while the only request header is the public UA.
- **C-m4 — one torn NDJSON line bricks the store** — DEFERRED to backlog (store durability / projection-rebuild): the right semantics is a design question the plan never took, and silently skipping a torn line loses a release id and re-accepts it. The failure is loud today, and the projections are rebuildable-from-journal by design. Do not re-raise as a revision item; it needs a rebuild path.
- **I-m3 — `checksums.sha256` has no automated consumer** — DEFERRED to backlog (fold into CI at /ship): additive test surface the plan did not scope; byte-identity was verified this round and the contract tests pin the load-bearing fixture facts incidentally.
- **Q-m1, Q-m5 — test-helper tidying** — DEFERRED: `test/helpers/fixture-transport.ts` and `support.ts` are not touched by any fix this round; an unrelated diff in a helper five test files depend on is not worth a reader-clarity win. Do next time those files are edited.
- **Stray `test/replay-multi-run.test.ts` (written by the I-M1 verifier, owned by no plan step)** — ADOPTED as the I-M1 regression test, to be rewritten in place. Its 5 tests currently pass *by asserting the bug* ("replaying run B diverges at exchange 1", "run A succeeds silently"), so the suite is green while encoding the defect. Rewrite inverts them (run B must replay correctly after the fix), keeps the two-run store fixture, and the file gets recorded against plan step 5's replay bullet so it stops being unowned. Deleting it was rejected: it already builds exactly the store state the fix must handle.
- **Test edits authorised for items 3, 7, 8, 10, 11 and the item-1 rewrite** — ACCEPTED as deliberate behaviour change, not weakened tests: C-M3 changes `lastSeenRelease` semantics, C-M4 changes quarantine idempotency, C-m2 changes counter reconciliation, C-M1 adds a cross-run sleep. Each requires an added or updated assertion, named per item in the worklist. Nothing may be relaxed to go green.
- **Plan defects found by review, to be corrected with the code** — ACCEPTED: (1) plan:68 asserts normatively that "quarantine is stable across re-runs by construction" — C-M4 proves this false at dedupe case 1; (2) plan:195-197's jq pacing check groups by `runId` and is therefore structurally blind to the cross-run violation C-M1 found — it returns 13 for exactly the journal containing a 1 s gap; (3) the plan never specified run selection for §5.3 replay, which is how I-M1 shipped. Each has a bounded local fix, so this is REVISE, not REPLAN — recorded here so round 2 does not re-derive them.
- **Adjudicator agent reported "failed" (session limit) but artifact is complete** — NOT a harness fault: worklist.md (396 lines, valid VERDICT REVISE/13/blocking 1) and this ledger append both landed before the limit hit; the failure was in the final moment after the substantive write. No rework needed.

## Round 2 re-review — 2026-08-13 (Phase 1 slice 1)
- **Revise loop converged in one round.** Round-2 panel (correctness, security, integration — simplicity skipped: 0 majors round 1, guards-added diff) all APPROVED 0/0/0. All 9 round-1 majors verified genuinely closed by executing the round-1 failing cases against the rebuilt dist/ (correctness 36/36 closure assertions; security bypass-tested the origin/Retry-After/walk-bounds guards; integration reproduced the I-M1 two-run replay fix). Zero regressions, zero new findings. No adjudication/verification needed — nothing to verify. Advanced to QA.
- **Fixture PII (S-m7): Henry's decision = accept + note in test/fixtures/README.md.** Repo stays public. README note added at finish (does not touch byte-exact fixtures).
