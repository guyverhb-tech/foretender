# Contract-test fixtures

Real recorded FTS responses, committed whole and unedited (BUILD_BRIEF §9).
**Never edit any file in this directory.** Integrity is pinned by
`checksums.sha256` (`shasum -a 256 -c test/fixtures/checksums.sha256` from the
repo root) and each file is byte-identical to its Phase 0 original.

## Provenance

Fetched 2026-08-12 during the Phase 0 corpus walk against
`https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`. Copied
byte-for-byte from `.harness/research/samples/` (untracked — `.gitignore`
excludes `.harness/research/`), same relative paths. Selection rationale,
recording context, and per-file notes: `.harness/research/samples/sample-manifest.md`
and `.harness/research/samples/probe/index.md`.

## Personal data notice

These are real, unedited notices and therefore contain the personal contact
details their publishers put on the public register — `contactPoint` names,
email addresses, and telephone numbers of procurement officers (page-001 alone
carries ~150 unique emails and 31 phone numbers). The data is published by the
Find a Tender service under the Open Government Licence v3; committing it here
republishes already-public register data as recorded, byte-for-byte. This is a
deliberate, reviewed decision (Phase 1 slice 1 security review, `S-m7`):
committed as-is because the contract tests depend on the exact bytes
(BUILD_BRIEF §9 requires fixtures whole and unedited), and this repository is
public by design. The fixtures must not be redacted — doing so breaks the byte
contract and the tests that pin it.

## Files

### `whole-stream/` — pages of the recorded 30-day whole-stream walk

Window `updatedFrom=2026-07-13T00:00:00&updatedTo=2026-08-12T00:00:00`,
`limit=100`, no `stages=`. Each page is a `.json` body plus its recorded
`.headers`.

- `page-001` — the genuine cursor-less first page; its `uri` is the initial
  URL the ingest core must construct.
- `page-002`, `page-003` — the real `links.next` chain from page-001.
- `page-050` — carries the byte-identical server-side duplicate release
  `071452-2026` (100 releases, 99 unique) — the mandatory dedupe fixture.
- `page-111` — 37 releases and **no `links` key**: the only recorded terminal
  page of the walk.

**Synthetic chain hops:** the tests walk 001 → 002 → 003 → 050 → 111. The hops
003→050 and 050→111 are synthetic *routing* of unedited real bodies — the test
transport maps page-003's recorded `links.next` URL to page-050's recorded
exchange, and page-050's to page-111's. Every body and header file is the real
recording, byte-identical; only the chaining between them is arranged by the
test (plan step 1, critique N1).

### `probe/` — targeted probe recordings

- `20-window-noZ-429.headers` + `.txt` and `22-window-noZ.json` + `.headers`
  are a **recorded same-URL retry pair**: the identical URL
  (`?updatedFrom=2026-08-11T16:00:00&updatedTo=2026-08-11T17:00:00&limit=100`)
  answered 429 at 08:38:39 (`retry-after: 120`, `content-type: text/plain`,
  58-byte plain-text body) and then 200 at 08:41:17 with 43 releases and no
  `links`. Together they are a fully real recording of the entire
  retry-then-complete path.
- `24-stages-combo.json` + `.headers` — a real empty 200 (`releases: []`, no
  `links`). It was recorded under a `stages=planning,tender` query, which
  invariant #1 forbids the ingest core from ever constructing; it is reused
  here as an empty-page *body* fixture only (critique N3).
