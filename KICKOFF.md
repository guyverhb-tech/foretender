# KICKOFF.md

Companion to `BUILD_BRIEF.md`. Written 12 Aug 2026, after the brief was signed off.
Read both before doing anything. Where the two conflict, this file wins — it is later.
This file does not restate the brief. It carries three things: decisions made since
sign-off, facts verified since sign-off, and the operational start sequence.

---

## 1. Decisions since brief sign-off (12 Aug 2026)

**1.1 — Phase 1's external user is a public scoreboard.**
The brief's Phase 1 definition of done includes a grading loop and a written
scoreboard summary. Decision: that scoreboard becomes a public page — predictions
stated in advance, outcomes graded against subsequent notices, calibration shown,
misses included. Grading rules are written and committed *before* the predictions
they grade. Publication venue (henryguyver.com vs. a repo-hosted page) is decided
at the first real resolution, not now. Until the grading loop has resolved at least
one real prediction, no page exists.

**1.2 — Published lens: UK public sector tech, AI-forward.**
Ingestion remains whole-stream — the deterministic core does not know about the
lens. The lens is the editorial/presentation layer only: which slice gets surfaced,
predicted on, and published. It is deliberately reversible; per-category volume
from Phase 0 / early ingestion may adjust it. Predictions target concrete
procurement processes (specific ocids, specific lifecycle transitions), never
fuzzy category aggregates — AI has no clean CPV code, and grading must not inherit
classification fuzziness.

**1.3 — Supplier subject: confirmed none exists.**
Per brief §10.1 this affects Phase 3 only. Henry will name the Phase 3 user
himself, later. Do not design for a hypothetical supplier before then.

**1.4 — Runtime: still open, one new input.**
Brief §10.2 stands: raise a recommendation with reasoning before choosing; do not
resolve silently. New consideration to weigh (not a decision): the harness's gap
detection currently covers JS/TS only, so a TypeScript build gets fuller harness
coverage. Weigh it against fitness for the work; Henry decides.

---

## 2. Facts verified 12 Aug 2026

Marked per the brief's VERIFIED / ASSUMED convention. Sources: FTS developer
documentation, checked this date.

**VERIFIED**
- OCDS release endpoint: `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`
- Accepted query parameters: `stages`, `limit`, `cursor`, `updatedFrom`, `updatedTo`
  (anything else returns 400 with the allowed list)
- Rate limiting exists: on too many requests, wait the number of seconds in the
  `Retry-After` header before any further request
- Notice data is OCDS 1.1.5 with OCP extensions, Open Government Licence v3
- A separate `ocdsRecordPackages/{ocid}` endpoint returns compiled records per
  procurement process — do not depend on it; the brief's lifecycle machine derives
  state locally from the release stream
- data.gov.uk daily zips are XML per notice — avoid; ingest JSON via the API
- Docs for the researcher agent:
  - `https://www.find-tender.service.gov.uk/Developer/Documentation`
  - `https://www.find-tender.service.gov.uk/apidocumentation/1.0/GET-ocdsReleasePackages`

**ASSUMED — verify in Phase 0 before depending on**
- Exact datetime format accepted by `updatedFrom` / `updatedTo`
- Rate limit thresholds and sustainable polling cadence
- Pipeline notice publication volume — the brief's named kill-risk. Answer with
  counted numbers from live data, not from the Act's requirements.

---

## 3. Start sequence

**Step 0 — Henry, before Claude Code opens**
Create the project directory. Place `BUILD_BRIEF.md` and this file at repo root.
`git init`; create the GitHub repo on the personal account, public. (If public-
from-day-one feels wrong on the day, private is a one-flag change — but the messy
early history is part of the flagship story.)

**Step 1 — `/bootstrap`**
Day-one setup per its own definition. It reads the brief and this file first.

**Step 2 — `/scaffold-harness`**
Install the pipeline into this repo. This is the first repo it has ever been
installed in — expect integration-level faults, and treat them per §4 below.

**Step 3 — Phase 0, handed to the harness's research agents**
Phase 0 is research, not code: scout + researcher against the FTS docs and a
sample of live notices. Deliverable is a findings file answering, minimum:
the ASSUMED items above; pipeline notice volume (the kill-risk, with counts);
per-category notice volume for the lens sanity-check; what Stotles and Tussell
surface and miss (brief §10.3 — to avoid rebuilding the obvious, not to compete).
Henry reviews the findings file before any Phase 1 code exists. Supervised.

**Step 4 — First Phase 1 change through `/build-pipeline`, supervised**
This run is the harness's first end-to-end outing and the validation run that has
been gating overnight mode. Size it deliberately small — the smallest ingestion
slice consistent with the brief (indicatively: one Europe/London day of releases via cursor
pagination, stored raw and append-only, idempotent on re-run, `Retry-After`
honoured, junk quarantined not dropped). Final scoping happens after the Phase 0
findings are reviewed, not before.

**Step 5 — Overnight stays off**
`overnight.sh` remains disabled until at least one clean supervised full-pipeline
run has completed. Recommended: two clean runs before opening the gate.

---

## 4. Harness protocol for this build

This build is the harness's validation vehicle. That cuts both ways: the harness
gets exercised for real, and the build must not become a harness-debugging week.

- Henry supervises all pipeline runs until the overnight gate opens.
- When the harness itself faults: up to ~30 minutes fixing it in-line. Past that,
  bypass, complete the build step by hand or with a plain session, and record a
  dated entry in `decisions.md` stating what was bypassed and why.
- Harness fixes are batched and done as their own work, not interleaved with
  build milestones.
- The public claim "built with my pipeline" stays honest only if bypasses are
  logged. Log them.

---

## 5. Out of scope until Phase 0 findings are reviewed

No classifier. No lens implementation. No prediction logic. No public page.
No backfill beyond samples. No Contracts Finder, Sell2Wales, or Public Contracts
Scotland — FTS only. No record compilation via `ocdsRecordPackages`.

---

## 6. First message to paste into Claude Code

> Read BUILD_BRIEF.md and KICKOFF.md in full. Confirm your understanding of the
> start sequence and the harness protocol in one short summary, flag anything in
> the two files that conflicts, then propose the Phase 0 research task plan for
> approval. Do not write code.
