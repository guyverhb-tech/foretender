# Phase 0 findings — foretender

**Date:** 2026-08-12. **Method:** 24 live probe requests against `GET /api/1.0/ocdsReleasePackages` plus 123 corpus-fetch requests (147 total, zero rate-limit events during the corpus fetch), followed by disk-only analysis of the saved payloads and documentation-tier research for Scotland and incumbents. **Corpus:** a complete 30-day whole-stream walk (2026-07-13 → 2026-08-12 Europe/London, 11,036 unique releases across 111 pages), three stage-filtered corpora (90-day planning and tender, ~7.5-day award — all of which turned out to be CELEX-only, see the trap below), and every probe response, all saved raw under `.harness/research/samples/` with provenance in `sample-manifest.md` / `manifest.json`. Every number in this file cites the research artifact it comes from; the artifacts cite the saved payloads. **Precedence (set at the Phase 0 review, 2026-08-12): on data facts, this file supersedes KICKOFF §2, which supersedes BUILD_BRIEF §4.**

---

## The kill-risk: pipeline notice volume — GO

The brief (§4) named one assumption as the single biggest kill-risk: that pipeline notices are published in meaningful volume. **They are. Verdict: GO.** (`.harness/research/pipeline-volume.md`)

**Counted volume** (30-day whole-stream census, Act regime = `tender.legalBasis.scheme: "UKPGA"`):

- **952 `planning` + 278 `planningUpdate` releases in 30 days — ~222 new planning notices/week across 918 distinct procurement processes.** Weekly counts 205 / 201 / 230 / 232 (and 84 in the final 2-day partial week) — steady, no sign of decline. (pipeline-volume.md §2)
- Planning volume is ~73% of new-tender volume (952 vs 1,296 UKPGA tender releases). (pipeline-volume.md §2)
- The planning family is typed by an observed field, `planning.documents[].noticeType` (present on 1,230/1,230 UKPGA planning-family releases, 0/89 CELEX): **UK1 pipeline notices 123, UK2 preliminary market engagement 740, UK3 planned procurement 89** (plus 50/203/25 updates respectively). Even the strictest "pipeline" reading — UK1 only — runs ~29/week. (pipeline-volume.md §1–2)

**Linkage — the flagship prediction is gradable.** The later tender release reuses the planning process's `ocid`:

- **44 of 918** UKPGA planning ocids gained their first tender release inside the single 30-day window. By type: **UK3 13/79 (16.5%)**, UK1 7/104, UK2 24/706. In-window lags: median 6 days, max 27 (mechanically truncated by the window). (pipeline-volume.md §3)
- **Denominator reconciliation (Phase 0 review, verified against the corpus):** the per-type denominators sum to 889, not 918. The missing **29 ocids carry planning notices of more than one type** — staged progressions, ordered by release date: UK1→UK2 ×17, UK2→UK3 ×8, UK3→UK2 ×2, UK2→UK1 ×2. As their own cohort: **0/29 converted to tender in-window** — consistent with a progression marking a process still early in its pipeline journey rather than contradicting the review's high-signal hypothesis; a longer window must test it (see Unresolved). 889 single-type + 29 multi-type = 918; all 44 observed conversions sit in the single-type cohorts.
- `relatedProcesses` is **not** the link — 0 planning→tender links observed; 512/555 occurrences are framework references on award releases. Grade on ocid identity. (pipeline-volume.md §3)
- Prediction raw material exists: UK3 notices carry an anticipated tender deadline (`tender.tenderPeriod`) 74% of the time and a value 80%; UK2 carries engagement milestones with `dueDate` 95%. (pipeline-volume.md §3)

**Window limitation, stated plainly:** the 30-day window is *shorter than the typical planning→tender lag*. Legacy-regime (CELEX, 90-day corpora) evidence puts the median lag at **38.5 days** (min 14, max 56; 18 conversions), and the least-censored legacy cohort converted 12.5% within a 60-day horizon; the least-censored Act-regime cohort converted 13/196 = 6.6% within ≤30 days. **All in-window conversion rates are floors, not rates** — the true Act-regime conversion rate at the weeks-months horizon needs 60–90 days of ingestion to measure. What is established: conversions happen, are visible within weeks, and the join key (ocid) is stable. The ~5.5-week legacy median lands exactly in the prediction ladder's weeks-months horizon. (pipeline-volume.md §3)

**Two binding conditions on the GO**, both already evidenced:

1. **Ingest must be whole-stream** — the `stages=` filter excludes the entire Act regime (next section).
2. **Define the prediction population by `noticeType`, not tag.** UK2 (77% of planning volume) is market engagement with a ~3.4% 30-day conversion floor; UK3 converts ~5× faster. One undifferentiated conversion prediction would be miscalibrated by construction. (pipeline-volume.md §4)

**Open decision for the Phase 1 plan — OD-1** *(named at the Phase 0 review; decided in the plan, not silently)*: BUILD_BRIEF §7 scopes Phase 1 to exactly one prediction type, and this file shows an undifferentiated conversion prediction would be miscalibrated by construction. The plan must choose between (a) one pipeline-to-tender prediction type with its population segmented by `noticeType` (per-type calibration tracks), or (b) UK3-only to start (highest conversion signal, ~89 notices/30d). The 29-ocid multi-type progression cohort above is candidate input to either.

---

## The stages-filter trap

The sampler's central discovery, and Phase 0's most important negative result (`.harness/research/sample-manifest.md`, escalated per BUILD_BRIEF §9 stop-and-report):

**The `stages=` parameter silently returns only pre-Procurement-Act releases.** Every release in the three stage corpora (1,121 total) has `tender.legalBasis.scheme = "CELEX"` — transitional PCR 2015-era procedures. Every UKPGA 2023/54 release is excluded from all three stage filters regardless of tag. The filter also drops **all** update/amendment/cancellation/termination tags even for the old regime (170 CELEX tenderUpdates and 129 CELEX awardUpdates existed in-window; none returned). Effective semantics: `stages=planning` → tags {planning; planning,tender}, `stages=tender` → {tender; planning,tender}, `stages=award` → {award,contract}, each ∩ CELEX-only. The API documentation describes `stages` only as "Stage of the contracting process" — the restriction is **undocumented**.

Evidence is threefold and exact (sample-manifest.md, manifest.json `findings[0]`): 100% CELEX legal basis across all three corpora; a discriminating test against a saved whole-stream hour (all 6 CELEX releases present in the stage corpora, all 37 UKPGA absent, 43/43 consistent); and an exact count reconciliation over the 30-day window in both directions.

**Consequences:**

- A stage-filtered ingest would see ~17.5% of the live stream — the shrinking transitional regime — and **zero** Act-regime notices, i.e. none of the notices the kill-risk question or any §6 prediction is about, and zero amendment/update events of any kind.
- **Phase 1 ingestion must be whole-stream (no `stages` param).** KICKOFF §1.2 already decided this editorially ("ingestion remains whole-stream"); this finding makes it technically mandatory, independent of the lens decision.
- `stages=` must never be used anywhere completeness matters. Its only safe use is deliberately sampling the CELEX transitional regime.

---

## The ASSUMED ledger

Every ASSUMED item from BUILD_BRIEF §4 and KICKOFF §2, resolved. None was refuted outright; the surprises are conditions and caveats, recorded in the topic sections.

| # | ASSUMED item (source) | Verdict | One-line evidence | Artifact |
|---|---|---|---|---|
| 1 | A bulk download / API endpoint exists for notice retrieval, and its rate limits (brief §4) | **VERIFIED** | `GET /api/1.0/ocdsReleasePackages`, 5 params, `limit` ≤ 100, cursor pagination via `links.next`; live 429 observed: "Rate limit of 12 exceeded", `Retry-After: 120` | api-mechanics.md |
| 2 | Exact shape of the OCDS release package and which extensions are in use (brief §4) | **VERIFIED** | Envelope `version: "1.1"` (docs: mapped to OCDS 1.1.5); 9–10 unpinned extension URLs, varying per response: EU profile + 6 OCP extensions + Cabinet Office UK extension + one third-party Links extension | package-shape.md |
| 3 | Pipeline notices are published in meaningful volume — the kill-risk (brief §4, KICKOFF §2) | **VERIFIED — GO** | 952 planning + 278 planningUpdate UKPGA releases in 30 days (~222/week, 918 distinct processes), stable week over week | pipeline-volume.md |
| 4 | Award notices reliably publish the winning supplier and final value (brief §4) | **VERIFIED, conditional** | Act regime: supplier name 99.6% (5,821/5,846), value 98.8% — but only if ingest reads `value.amountGross` as well as `amount` (strict-`amount` coverage is 86.7%) | award-completeness.md |
| 5 | Whether bidder counts are published on award notices (brief §4) | **VERIFIED — narrowly published** | `bids.statistics` appears only on UK6 contract-award notices: 96.7% of competitive-procedure UK6s, 12.2% of Act-regime award releases overall (vs 94.7% in the dying CELEX regime) | award-completeness.md |
| 6 | Whether Scottish below-threshold notices need a separate source (brief §4) | **VERIFIED — they do** | PRSA 2014 s.23 puts them on Public Contracts Scotland only; FTS structurally never carries them. Scottish above-threshold notices DO reach FTS via PCS auto-forwarding, as legacy-regime notices | scotland-coverage.md |
| 7 | Exact datetime format for `updatedFrom`/`updatedTo` (KICKOFF §2) | **VERIFIED** | `YYYY-MM-DDTHH:MM:SS`, seconds mandatory, interpreted as Europe/London local; trailing `Z` accepted syntactically but **silently ignored**; date-only and no-seconds forms 400 | api-mechanics.md |
| 8 | Rate limit thresholds and sustainable polling cadence (KICKOFF §2) | **VERIFIED, window inferred** | ~12 requests per rolling ~120 s (live 429 + Retry-After 120; window size inferred from one incident, not proven); 123 requests at 13 s spacing produced zero 429s | api-mechanics.md, sample-manifest.md |

One adjacent claim from KICKOFF §2 was contradicted by live behaviour: the docs' sample `Retry-After: 11` is wrong in practice — the live value was 120. Trust the header at runtime, not the docs (api-mechanics.md).

---

## API mechanics and sustainable polling cadence

Source: `.harness/research/api-mechanics.md` (24 saved probe requests + saved docs pages).

- **Endpoint:** `GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`. Exactly five parameters — `stages`, `limit`, `cursor`, `updatedFrom`, `updatedTo`; anything else 400s naming that list. `limit` max 100 (101 → 400).
- **The timezone trap (biggest sharp edge):** `updatedFrom`/`updatedTo` are **Europe/London local time**. A trailing `Z` is accepted and silently ignored — proven by a discriminating test: a fixed window queried with and without `Z` returned identical 43-release id lists. Sending UTC-with-Z during BST skews the window by an hour with no error. Use the 19-char local form only.
- **Rate limit:** observed live at ~1 req/s — HTTP 429 from `awselb/2.0` on the 18th request in ~2¼ minutes, plain-text body "Rate limit of 12 exceeded. Please retry after 120 seconds.", `Retry-After: 120`. No `X-RateLimit-*` headers on 2xx. **Sustainable cadence: ≥12 s between requests (15 s for headroom)** — 123 corpus requests at 13 s spacing produced zero 429s (sample-manifest.md). On 429/503, sleep the `Retry-After` value and retry the same URL; check every status before the next request. 429/503 bodies are plain text — a JSON-expecting error handler will throw.
- **Ordering is descending** (newest first, by internal notice-id sequence; release `date` is only approximately monotone — 26 seconds-level inversions across 11,037 releases). A naive "resume from last seen" design inherits this.
- **Pagination:** `links.next` is a complete URL with the cursor embedded; the cursor is transparent base64 embedding the window. Termination is the **absence of the `links` key**, not an empty `releases` array. Empty result = 200 with `releases: []`. Cursor is stable within a walk; validity across days untested — persist the window + last-seen release for resume, not the cursor.
- **Never comma-combine stages:** `stages=planning,tender` returns 200 with zero releases — no error.

---

## The corpus

Source: `.harness/research/samples/sample-manifest.md` + `manifest.json`. Everything lives under `.harness/research/samples/`.

| Corpus | Query | Window covered | Releases |
|---|---|---|---|
| `whole-stream/` (primary, 111 pages) | no `stages` | 2026-07-13 → 2026-08-12, **complete** | 11,037 raw / **11,036 unique** (one byte-identical server-side duplicate, `071452-2026`) |
| `planning/` | `stages=planning` | 90 days complete — but CELEX-only | 274 |
| `tender/` | `stages=tender` | 90 days complete (two sub-walks, no boundary loss) — CELEX-only | 547 |
| `award/` | `stages=award` | 2026-08-04 → 2026-08-12 only (≥300 stop rule) — CELEX-only | 300 |
| `probe/` | mechanics probes | point-in-time | 24 saved request/response pairs |

Whole-stream composition: **UKPGA 9,110 unique (82.5%) / CELEX 1,926 (17.5%)**, ~368 releases/day. Tags (deduped): award,contract 7,196 · tender 1,484 · planning 1,034 · tenderUpdate 554 · planningUpdate 278 · awardUpdate,contractUpdate 225 · tenderCancellation 114 · contractTermination 80 · contractAmendment 60 · planning,tender 7 · implementation 4 (package-shape.md §7, sample-manifest.md).

Known gaps, by design or by the trap: no UKPGA payloads before 2026-07-13 (the 90-day corpora are CELEX-only); the award stage corpus omits the older 82 days of its window; releases updated after 2026-08-12T00:00 excluded; 15 dual-tagged `planning,tender` releases appear in both `planning/` and `tender/` (dedupe on release id).

Dual-tag reconciliation (Phase 0 review, verified against the corpus): **all 7 `planning,tender` dual-tagged releases in the whole-stream window are CELEX** — the 89 CELEX planning-family count reconciles exactly as 82 pure `planning` + 7 dual-tagged.

---

## Award completeness

Source: `.harness/research/award-completeness.md`. Population: 7,196 `award,contract` releases in 30 days = **UKPGA 5,846** / CELEX 1,350.

- **Winner: 99.6%** of UKPGA award releases name the supplier. Structured identifiers (scheme+id, GB-PPON dominant) 84.2%.
- **Value: 98.8% — but only via `amountGross`.** Strict `value.amount` coverage is 86.7%; 886 value objects are gross-only. `amountGross` is a UK-extension field absent from the CELEX regime entirely. Grade net-vs-net or gross-vs-gross, never across.
- **The `award,contract` tag conflates five notice types** (split only by `documents[].noticeType`): UK7 contract details 4,062 · UK6 contract award 1,327 · UK5 transparency 389 · UK14+UK15 dynamic market 68 — the last are **not contract awards** (member lists with up to 127 value-less "awards" each) and will poison naive rates. Field placement differs per type: UK6 → `awards[].value` + `awards[].date`; UK7 → `contracts[].value` + `dateSigned`; UK5 has no date anywhere by design.
- **One award, two releases:** 169 ocid pairs publish the same award as UK6 (decision) then UK7 (signature). 5,846 releases = 5,280 ocids. The lifecycle machine must treat UK6→UK7 as one award progressing.
- **Bidder counts:** only on UK6, and only for competitive procedures — 712/736 competitive UK6s (96.7%), zero on direct awards / framework call-offs / UK5 / UK7. That is 12.2% of Act-regime award volume, vs 94.7% in the CELEX regime — bidder statistics are a **shrinking** data source under the Act. **Do not build predictions on `bids.statistics`** (Phase 0 review annotation): 12.2% of award volume and falling as the CELEX regime expires.
- **The tender estimate is never restated on the award** — `tender.value` on 0/5,846 UKPGA award releases. "Final vs estimate" grading depends entirely on the longitudinal store having ingested the tender notice (estimate present on 82.9% of UKPGA tenders). The 30-day ocid-join rate (29/5,846, 1 estimate recovered) is a window artifact, not a defect — tender→award gaps exceed the window. Population bound: only ~24% of Act-regime award volume comes from open/competitive procedures that had a tender notice at all. This directly confirms the brief's longitudinal-store premise and scopes the months-horizon prediction.
- **Gradeable universe for the months-horizon rung, stated explicitly** (Phase 0 review annotation): ~24% competitive-procedure share × 82.9% estimate presence ≈ **~20% of Act-regime award volume is gradeable for "final value vs estimate"**. A property of the data, not a defect — and the scoreboard must display the gradeable-population denominator alongside every rung, this one included.
- Junk is small: 25 zero-value releases (0.43%), zero placeholder supplier names.

---

## Package shape and declared extensions

Source: `.harness/research/package-shape.md`.

**Stop-and-report check (brief §4 duty): every brief-named field concept exists in real UKPGA payloads — there is no missing-field stop-and-report.** But several concepts live at nonstandard paths, and a normaliser written from recalled core-OCDS paths would silently miss 18–100% of the data:

| Brief §4 concept | Real UKPGA path | Presence (n=1,296 tenders) |
|---|---|---|
| Estimated total value | `tender.value.amountGross` (UK-extension, VAT-inclusive) | 99.1% (core `amount` only 81.7%) |
| Contract start/end dates | `tender.lots[].contractPeriod` — **lot-level only**; tender-level `contractPeriod` occurs 0 times in the corpus | 99.1% |
| CPV classifications | `tender.items[].additionalClassifications[]` (scheme CPV, 8-digit) — `items[].classification` occurs 0 times anywhere; `tender.classification` is CELEX-only | 100% |
| Procurement category | `tender.mainProcurementCategory` | 100% |
| Submission deadline | `tender.tenderPeriod.endDate` (89.0%) ∪ `tender.expressionOfInterestDeadline` (10.2%, exactly the competitive-flexible two-stage tenders) | 99.2% (the 10 without either are UK13 dynamic-market notices, legitimately deadline-free) |
| Possible extensions | `tender.lots[].hasRenewal` + `renewal.description` + `contractPeriod.maxExtentDate` (perfectly correlated) | 53.6% |

- **Envelope:** `version: "1.1"`, publisher Cabinet Office, OGL v3. KICKOFF's "OCDS 1.1.5 with OCP extensions" is right in substance, incomplete in detail: 9–10 extension URLs, **all unpinned** (`latest`/`master`/`main`), and the list **varies per response** (the performance-failures extension appears only on whole-stream pages). Do not treat the extensions array as a schema contract.
- **Two observed fields are defined in no declared schema:** `tender.items[].deliveryAddresses` (81.6% of UKPGA tenders) and release-level `buyerID` (14.9%). The payload exceeds its declared schemas; strict validation would reject most real releases.
- **CELEX releases use materially different paths** (value in `amount` only at 70.3%, duration instead of dates, CPV in `tender.classification`, booleans present-both-ways vs UKPGA's only-when-true). **Phase 1's normaliser must branch on `tender.legalBasis.scheme` — present on 11,036/11,036 releases.**
- **Junk is semantic, not structural:** 0 malformed records, 0 missing core keys; 3.94% zero-value tenders (51/1,296), ~0 true placeholder text. A substring "test" quarantine rule would false-positive ~70× (fire testing, MOT testing…).

---

## Versioning and the amendment signal (days-horizon grading)

Source: `.harness/research/release-versioning.md`.

- **The amendment event is the tag, not the amendments block.** FTS versions a procurement by publishing a new release under the same ocid with a new notice id and `tag: ["tenderUpdate"]`. The `tender.amendments` block is optional decoration: absent in 130/384 (34%) of Act-regime tenderUpdates, never accumulating (max length 1 corpus-wide), always self-referencing its own release id (514/514), and **no `amendsReleaseID` back-pointer exists anywhere** despite OCDS defining one. Version order = per-ocid notice-id order (agrees with date order in all 1,014 multi-release ocids).
- **Deadline extension = diffing parsed datetimes across successive releases:** `tender.tenderPeriod.endDate` for single-stage; `tender.expressionOfInterestDeadline` for two-stage (which have no `tenderPeriod` at all); for CELEX, `tender.amendments[].unstructuredChanges[]` old/new values (section IV.2.2). Observed in 265 consecutive UKPGA update pairs: 72 endDate changes (52 extensions, 20 shortenings — "extended" must be `new > old`), 14 EOI-deadline changes (9 extensions). `enquiryPeriod.endDate` is the clarification-questions deadline and must not resolve a submission-deadline prediction. Amendment description text is unreliable in both directions (half of real deadline changes have silent descriptions; 25 keyword-matching descriptions had no endDate change).
- **Volume for the days-horizon rung is real:** 13.3% of in-window UKPGA tenders received ≥1 update (right-censored floor); gap to first update median 1.1 days, p75 6.7.
- **Traps for the lifecycle machine:** CELEX updates are sparse corrigenda (median 61 paths removed), not snapshots — a generic differ hallucinates removals; `tenderCancellation` releases are sparse stubs whose `tender.status` contradicts the tag in half the cases (last-release-wins merging would erase the tender); 227 ocids enter the window as orphan tenderUpdates (brief §5.4's out-of-order reality, confirmed); multiple updates can land minutes apart.

---

## Lens volume (KICKOFF §1.2 sanity check)

Source: `.harness/research/lens-volume.md`. **GO.**

- **Tech slice (CPV division 72 ∪ 48 ∪ group 302): 126 new tender releases in 30 days (~29/week, 88% Act-regime)**, plus ~46/week planning-tagged and ~13/week tenderUpdate releases in the same slice — enough concrete ocids for calibration-volume predictions. Division 72 ranks 7th of all divisions; group 302 is negligible (7/30d).
- **Strict AI-keyword subset: 18 tender releases in 30 days (~3–6/week, 1.2% of tender flow)**, zero false positives on manual review, zero LLM/GenAI/large-language-model matches — buyers write "AI" and "artificial intelligence". The AI layer is editorial; it rides on the tech slice and cannot alone sustain calibration volume.
- **KICKOFF's premise "AI has no clean CPV code" is VERIFIED:** zero AI codes among all 3,107 distinct classification entries in the corpus, and 8 of 18 AI hits carry no tech-division CPV at all — a CPV-only lens would miss 44% of keyword-visible AI procurement. Concrete-ocid prediction (never category aggregates) is exactly right for this data.
- Sharp edge: all 114 tenderCancellation releases carry zero CPV (no `items` at all) — cancellations must be joined to their parent tender by ocid before slicing.

---

## Scotland

Source: `.harness/research/scotland-coverage.md`. **The ASSUMED item is CONFIRMED with a precise boundary.**

- **Scottish below-threshold notices can never appear on FTS.** Regulated procurements from £50k goods/services / £2m works (ex VAT) up to the PC(S)R 2015 thresholds — £139,688 (central) / £214,904 (other) goods/services and £5,372,609 works (incl VAT) — are published on Public Contracts Scotland only (PRSA 2014 s.23). Below £50k/£2m there is no advertising duty at all. FTS states the gap on its own homepage.
- **Scottish above-threshold notices DO reach FTS automatically** (PC(S)R 2015 regs 50–52, PCS auto-forwarding) — but as **legacy-regime notices outside the Procurement Act taxonomy**, because s.2(5)(a) of the Act excludes devolved Scottish authorities. Devolved Scotland will therefore never publish UK1–UK3 planning notices: **the pipeline prediction is structurally rest-of-UK-only.**
- Cross-artifact corroboration the Scotland artifact asked for: the package-shape census found **346 CELEX releases in the saved corpus whose `links[].rel:"canonical"` points at `api.publiccontractsscotland.gov.uk`** (e.g. release `076457-2026`, package-shape.md §4) — PCS-forwarded notices demonstrably flow through the `ocdsReleasePackages` stream, re-minted with FTS `ocds-h6vhtk-*` ocids. A per-release buyer-domicile check was not run; that residue stays in Unresolved.
- Since KICKOFF §5 scopes PCS out, the operative consequence is a **documented, permanent blind spot** below the Scottish above-threshold line — a scoping fact to state honestly on any public page, not a build item.

---

## Incumbents and the scoreboard gap

Source: `.harness/research/incumbents.md`. All feature claims are vendor marketing, labelled as such in the artifact.

- **Five incumbents profiled:** Stotles (freemium, £75–475+/mo, 100+ portals aggregated), Tussell (~£11,400/licence/yr per its G-Cloud listing; spend-side depth, document-mined "Early Opportunities"), Tracker Intelligence (BiP; ~£1,000/yr entry per competitor comparison, tier-5 evidence), Tenders Direct (Proactis; "Advance Tender Alerts" = contract-expiry arithmetic, explicitly "not guesses"), and newcomer Civant (forecasting-first, customers-only accuracy reporting).
- **None publishes falsifiable advance predictions with public grading or calibration.** Every incumbent "pre-tender" offering is expiry arithmetic, document-mined buying signals, or customer-only forecasts. Zero platforms publish prediction accuracy or a track record. **The public graded scoreboard (KICKOFF §1.1) occupies genuine whitespace.**
- Already commodity — do not rebuild: multi-portal aggregation, expiring-contract detection, keyword alerts, buyer/contact databases, spend dashboards, framework call-off matching. The years-horizon "re-let on schedule" rung overlaps incumbent expiry detection; the differentiator is stating the prediction in advance and grading it publicly.
- Caveat on the negative: absence across the whole market can't be proven from a finite search — high confidence for these five, medium for the universe.

---

## Unresolved

What Phase 0 could not settle, and what would settle each item.

**API mechanics** (api-mechanics.md):
1. **Exact rate-limit window** — "12 per ~120 s" fits the one observed incident but is inferred, not proven. Settled by long-run polling telemetry in Phase 1; deliberately re-triggering 429s was ruled out.
2. **Per-IP vs per-UA vs global limit**, and burst-vs-idle treatment — same route: telemetry.
3. **Cursor validity lifetime** — stable within a walk; untested across hours/days. Design already avoids depending on it (persist window + last-seen release).
4. **Winter timezone behaviour** — payload offsets and window parsing observed only under BST. Re-verify after the October clock change.

**Pipeline / prediction** (pipeline-volume.md, release-versioning.md, award-completeness.md):
5. **Act-regime conversion rate at the full weeks-months horizon** — the 30-day window only yields floors (6.6% first-week cohort; legacy 60-day analogue 12.5%). Settled by 60–90 days of Phase 1's own whole-stream ingestion — which also settles the conversion behaviour of the 29 multi-type progression ocids (0/29 in-window; the review's UK2→UK3 staged-progression high-signal hypothesis).
6. **Whether some Act-regime tenders start a new ocid after a planning notice on a different ocid** — zero observed in 30 days; a longer window settles whether same-ocid grading misses a class of conversions.
7. **True (uncensored) tender-update rate and gap distribution** — 13.3% / median 1.1 days are right-censored floors. Settled by ~6 weeks of ingestion.
8. **Whether `tenderUpdate` is the only amendment channel for Act-regime tenders** — no counter-example in 30 days; a later sampling window raises confidence.
9. **Steady-state tender→award join rate** (the "final vs estimate" gradeable universe) — settled after 2–3 months of ingestion; the ceiling is 82.9% estimate presence × ~24% competitive-procedure share.

**Data shape** (package-shape.md):
10. **UKPGA payload shape before 2026-07-13** — no Act-regime payloads on disk for the earlier 60 days of the 90-day window.
11. **Provenance of `deliveryAddresses` and `buyerID`** — defined in no declared schema; unpinned extension URLs make this unsettleable from outside. Treat as observed-but-undeclared; vendor the extension files at ingest-schema time (the declared URLs point at mutable `main`/`master`).

**Scope** (lens-volume.md, scotland-coverage.md, incumbents.md):
12. **Seasonality** — one 30-day August window; tech ~29/wk and AI ~3–6/wk are floors for planning, not forecasts. Re-run the (window-independent) scripts on a later window.
13. **Devolved Scottish buyer in a saved payload** — the PCS canonical-link evidence (346 releases) proves the forwarding pipe; a per-release buyer-domicile dissection would close the Scotland artifact's remaining residue.
14. **Incumbent unknowns** — Tussell/Tracker real pricing, Civant's UK coverage. None blocking; none worth a sales call.

---

## Evidence appendix

Research artifacts (each carries its own "Verified by" with saved-payload citations and reproduction scripts):

| Artifact | Topic | Independent reproduction (main session, 2026-08-12) |
|---|---|---|
| `.harness/research/api-mechanics.md` | Endpoint mechanics, datetime semantics, rate limit, fetch recipe | ✓ `limit=101` → 400 `"'limit' must not exceed the maximum value"` (saved `probe/10`) |
| `.harness/research/samples/sample-manifest.md` + `manifest.json` | Corpus provenance, completeness proofs, the stages-filter finding | ✓ 11,036 unique releases; stage corpora 100% CELEX; whole-stream UKPGA-dominant |
| `.harness/research/pipeline-volume.md` | Kill-risk: planning volume, taxonomy, planning→tender linkage | ✓ 952 planning / 918 ocids / UK1 123 · UK2 740 · UK3 89 / 44 conversions; + the 889-vs-918 denominator reconciliation |
| `.harness/research/award-completeness.md` | Winner/value/bidder-count rates, estimate recovery | ✓ supplier named 5,821/5,846 UKPGA award releases |
| `.harness/research/package-shape.md` | Envelope, extensions, brief-§4 field paths, junk census | ✓ `amountGross` 1,284/1,296 (99.1%) UKPGA tenders |
| `.harness/research/release-versioning.md` | Amendment signal, deadline-extension detection, version semantics | ✓ 1,014 ocids ≥2 releases; 183 ≥3; 53 ≥4 |
| `.harness/research/lens-volume.md` | Tech-slice and AI-subset volumes, CPV premise check | ✓ tech union 126; AI hits 18 (title+description alone gives 14 — lot-level text is load-bearing in the definition) |
| `.harness/research/scotland-coverage.md` | Legal split, FTS visibility boundary | ✓ 346 releases with `canonical` links to publiccontractsscotland.gov.uk |
| `.harness/research/incumbents.md` | Incumbent survey, scoreboard whitespace | n/a — documentation-tier web research; URLs cited in the artifact; not corpus-reproducible |

Reproduction method: every ✓ number was recomputed independently from the saved payloads by the main session (fresh scripts, not re-runs of the artifacts' embedded ones). One initial mismatch — AI hits 14 vs 18 — traced to a definitional difference (the artifact also scans `lots[].title`/`lots[].description`) and reproduced exactly under the artifact's stated definition.

Saved payloads (raw, with headers): `.harness/research/samples/{whole-stream,planning,tender,award,probe}/` — 123 corpus pages + 24 probe responses, fetch log at `samples/fetch.log`. Analysis scripts with captured outputs: `.harness/research/scripts/award-completeness/`, `.harness/research/package-shape-scripts/`, plus reproduction scripts embedded verbatim in pipeline-volume.md and release-versioning.md.

---

## Runtime recommendation

*Added by the main session per BUILD_BRIEF §10.2 / KICKOFF §1.4 — raised with reasoning, not resolved; Henry decides.*

**Recommendation: TypeScript on Node.js (LTS), strict mode, no framework for the core system.**

1. **Fitness for the data this file describes.** The normaliser must branch on `tender.legalBasis.scheme` across two materially different payload shapes, and the lifecycle machine is a state machine over five-plus notice families arriving out of order. TypeScript's discriminated unions with exhaustiveness checking are the strongest mainstream tool for exactly that shape of problem — an unhandled regime/state combination becomes a compile error rather than the silent coercion §5.4 forbids. The stream is JSON end to end; zero impedance.
2. **Harness coverage — KICKOFF §1.4's named input.** The harness's gap detection currently covers JS/TS only, and this build is the harness's validation vehicle. A TypeScript core exercises the full apparatus rather than a subset.
3. **Operational fit.** The ingest loop is a politely-paced (≥12–15 s) single-stream poller — trivial in Node's async model — and the eventual public scoreboard page (KICKOFF §1.1) will be web-stack regardless, so one language spans core and presentation.
4. **What Python would buy, and why it isn't decisive.** Phase 0's analysis scripts were Python, and calibration reporting is stats-adjacent. But grading is deterministic arithmetic (Brier score over resolved predictions), not data science — and one-off analysis scripts can remain Python without making the system polyglot.

Concrete shape, for the Phase 1 planner to confirm rather than pre-decided here: Node LTS + TypeScript strict; vitest contract tests against the recorded fixtures; the storage choice for the append-only ledger and replay (likely SQLite) is a Phase 1 plan decision, not a runtime one.
