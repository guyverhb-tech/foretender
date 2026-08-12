# Draft defect report — FTS `ocdsReleasePackages` `stages` parameter

*Draft for Henry to send to the Find a Tender service desk / API team (via the FTS
support route or e-procurement helpdesk). Written 2026-08-12; all observations from
that date against `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`.*

---

**Subject:** API defect report: `stages` parameter on `GET /api/1.0/ocdsReleasePackages` silently excludes all Procurement Act 2023 releases and all update-family releases

**Summary.** The `stages` query parameter (documented values `planning`, `tender`,
`award`) appears to have two undocumented restrictions that make it unsafe for any
consumer who expects stage filtering of the full stream:

1. **Only pre-Procurement-Act releases are returned.** Every release returned under any
   `stages` value has `tender.legalBasis.scheme: "CELEX"` (transitional PCR 2015-era
   procedures). Releases with `tender.legalBasis.scheme: "UKPGA"` (Procurement Act 2023)
   are never returned by a `stages`-filtered query, regardless of their tags — although
   they constitute ~82% of the current stream.
2. **All update-family releases are excluded, even for the old regime.** Releases tagged
   `tenderUpdate`, `planningUpdate`, `awardUpdate`/`contractUpdate`, `tenderCancellation`,
   `contractAmendment`, or `contractTermination` are never returned under any `stages`
   value, including CELEX ones.

The API documentation describes `stages` only as "Stage of the contracting process";
neither restriction is documented.

**Evidence** (30-day window, 2026-07-13T00:00:00 → 2026-08-12T00:00:00, all datetimes
London-local per observed parser semantics):

- An unfiltered walk of the window returns 11,037 releases: 9,111 UKPGA / 1,926 CELEX.
- The same window with `stages=planning` returns 89 releases, `stages=tender` 195,
  `stages=award` 300 (newest sub-window) — 100% CELEX in each case, and reconciling
  exactly to the CELEX subset of the unfiltered stream with update-family tags removed:
  `stages=planning` 89 = CELEX `planning` 82 + CELEX `planning,tender` 7;
  `stages=tender` 195 = CELEX `tender` 188 + CELEX `planning,tender` 7;
  `stages=award` = CELEX `award,contract` only (300/300 in the checked sub-window).
- Discriminating hour (2026-08-11T16:00:00–17:00:00): the unfiltered stream returns 43
  releases (37 UKPGA, 6 CELEX); stage-filtered queries return exactly the 6 CELEX and
  none of the 37 UKPGA — 43/43 consistent with the restriction.
- The window contained 170 CELEX `tenderUpdate` and 129 CELEX `awardUpdate,contractUpdate`
  releases; none is returned under any `stages` value.

**Reproduction:**

```
# 1. Unfiltered hour — 43 releases, mixed UKPGA/CELEX:
curl "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom=2026-08-11T16:00:00&updatedTo=2026-08-11T17:00:00&limit=100"

# 2. Same hour, stages=tender — only the CELEX subset comes back:
curl "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?stages=tender&updatedFrom=2026-08-11T16:00:00&updatedTo=2026-08-11T17:00:00&limit=100"

# Compare tender.legalBasis.scheme across the two result sets.
```

**Impact.** A consumer using `stages` to subscribe to, e.g., new tender notices receives
a silently shrinking ~18% slice of the stream (the transitional regime only), zero
Procurement Act notices, and zero amendments or cancellations — with HTTP 200 responses
throughout and no indication anything is missing.

**Related minor observations, same endpoint:**
- `stages=planning,tender` (comma-combined) returns HTTP 200 with an empty `releases`
  array rather than an error, though each value works alone.
- A trailing `Z` on `updatedFrom`/`updatedTo` is accepted syntactically but ignored — the
  value is parsed as Europe/London local time, which silently shifts the window by an
  hour during BST for callers sending UTC.
- The documented rate-limit example shows `Retry-After: 11`; the live value observed is
  `Retry-After: 120` ("Rate limit of 12 exceeded").

**Questions.** Is the CELEX-only behaviour of `stages` intended? If so, could the
documentation state it (and the update-tag exclusion) explicitly? If not, is a fix
planned, and is there a recommended interim pattern other than fetching unfiltered?

Contact: Henry Guyver, guyverhb@gmail.com.
