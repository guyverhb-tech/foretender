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
