# Phase 1 invariants

Distilled from the nine Phase 0 research artifacts (`.harness/research/`, evidence in
`PHASE0_FINDINGS.md`). This file rides with `BUILD_BRIEF.md` and `PHASE0_FINDINGS.md` as
builder-facing law: code that violates one of these is wrong even if its tests pass.
Data-fact precedence: PHASE0_FINDINGS.md > KICKOFF §2 > BUILD_BRIEF §4.

## Fetching

1. **Whole-stream only.** Never pass `stages=` where completeness matters — it silently
   returns only pre-Act CELEX releases and drops all update/amendment/cancellation tags.
2. **Datetimes are 19-char Europe/London local** (`YYYY-MM-DDTHH:MM:SS`, seconds
   mandatory, no `Z` — a trailing `Z` is accepted and silently ignored).
3. **≥13 s between requests.** On 429/503, sleep the `Retry-After` value (default 30) and
   retry the same URL; bodies are plain text, not JSON — the error handler must not
   assume JSON. Check every status before the next request.
4. **Pagination:** follow `links.next` while present; termination is the *absence* of the
   `links` key, not an empty `releases` array. Results arrive newest-first.
5. **Persist the window + last-seen release for resume, not the cursor** (the cursor
   embeds the window; validity across days is unproven).

## Identity and merging

6. **Dedupe on release `id`** (server-side byte-identical duplicates exist).
7. **Version order = per-ocid notice-id order.** Multiple updates can land minutes apart;
   out-of-order and orphan first-releases (e.g. a `tenderUpdate` with no prior release)
   are normal — record the anomaly, never crash or coerce (brief §5.4).
8. **UK6 → UK7 is one award progressing** (169 double-published pairs/30d): merge by ocid,
   don't count twice.

## Normalising

9. **Branch on `tender.legalBasis.scheme`** (`UKPGA` vs `CELEX`, present on 100% of
   releases). The two regimes use materially different paths.
10. **Read `tender.value.amountGross` alongside `amount`** (UKPGA value coverage is 98.8%
    with it, 86.7% without). Never mix gross and net in one comparison or grade.
11. **CPV lives in `tender.items[].additionalClassifications[]` for UKPGA** (never
    `tender.classification`, which is CELEX-only; `items[].classification` occurs zero
    times). Contract dates are lot-level (`tender.lots[].contractPeriod`).
12. **Split `award,contract` releases by `documents[].noticeType`** — the tag conflates
    UK5/UK6/UK7/UK14/UK15, and UK14/UK15 dynamic-market notices are *not* awards.
13. **Submission deadline = `tender.tenderPeriod.endDate` ∪
    `tender.expressionOfInterestDeadline`** (two-stage procedures have no tenderPeriod).
    `enquiryPeriod.endDate` is the clarification deadline — never the submission deadline.

## Lifecycle and grading

14. **Amendment = the `tenderUpdate` tag**, detected by direction-aware datetime diffs of
    the deadline fields across successive releases ("extended" ⇔ `new > old`). The
    `tender.amendments` block is unreliable decoration (absent in 34% of updates, never
    accumulates, no `amendsReleaseID` anywhere); amendment description text is unreliable
    in both directions.
15. **CELEX updates are sparse corrigenda, not snapshots** (median 61 paths removed) — a
    generic last-release-wins differ hallucinates removals. `tenderCancellation` releases
    are sparse stubs whose `tender.status` contradicts the tag half the time.
16. **Join cancellations to their parent ocid before any CPV slicing** — all 114 in-window
    cancellation releases carry zero CPV.
17. **Do not build predictions on `bids.statistics`** — 12.2% of Act-regime award volume
    and falling. **The scoreboard displays the gradeable-population denominator per rung**
    (months-horizon: ~24% competitive share × 82.9% estimate presence ≈ ~20%).

## Validation and quarantine

18. **Payloads exceed their declared schemas** (`deliveryAddresses`, `buyerID` are defined
    in no declared extension; extension URLs are unpinned and vary per response). Never
    strict-reject on schema mismatch; vendor the extension files if schema-validating.
19. **Quarantine, don't drop; junk is semantic, not structural** (3.94% zero-value
    tenders, 0 malformed records). A substring-"test" rule false-positives ~70× (fire
    testing, MOT testing) — quarantine rules must be field-specific.
