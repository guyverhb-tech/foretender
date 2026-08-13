import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestWindow } from '../src/ingest/ingest.js';
import { createRawStore } from '../src/store/raw-store.js';
import { createReplayTransport } from '../src/store/replay.js';
import {
  exchangeFromFixture,
  makeFixtureTransport,
  readFixtureBytes,
  wholeStreamChain,
  type PackagePage,
  type RecordedExchange,
  type ReleaseIdentity,
} from './helpers/fixture-transport.js';
import {
  dropRunScoped,
  httpRecords,
  makeVirtualClock,
  makeVirtualSleep,
  pagesDir,
  quarantinePath,
  readJournal,
  readQuarantine,
  readReleases,
  releasesPath,
  sha256Hex,
} from './helpers/support.js';

/**
 * Ingest core contract (brief reqs 2–6, invariants #1–#6, plan step 5) —
 * fixture-only, zero network (injected transport + fetch poison in setup).
 *
 * Binding addenda encoded here:
 *  - M1: journal timestamps must be faithful to the injected clock at each
 *    record (a stamp-once-at-beginRun build fails), and runId must be
 *    non-empty and stable across a run.
 *  - N1: frozen-snapshot semantics — run 1 quarantines 071452-2026 as
 *    `duplicate-id` (NOT alreadyPresent); run 2 yields
 *    {seen 437, accepted 0, alreadyPresent 437, quarantined 0} with the
 *    quarantine file unchanged. A live-set implementation fails run 1.
 *
 * Interface assumptions (see .harness/test-plan.md):
 *   ingestWindow({ transport, sleep, now, store }, { updatedFrom, updatedTo })
 *     → summary { pages, seen, accepted, alreadyPresent, quarantined,
 *                 lastSeenRelease, ok } — limit defaults to 100,
 *                 minSpacingMs to 13 000.
 *   createRawStore(rootDir, { now })
 *   createReplayTransport(rootDir) → transport
 */
const BASE = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);

const CHAIN_WINDOW = { updatedFrom: '2026-07-13T00:00:00', updatedTo: '2026-08-12T00:00:00' };
const RETRY_WINDOW = { updatedFrom: '2026-08-11T16:00:00', updatedTo: '2026-08-11T17:00:00' };
const RETRY_URL = `${BASE}?updatedFrom=2026-08-11T16:00:00&updatedTo=2026-08-11T17:00:00&limit=100`;

/** The byte-identical server-side duplicate carried by page-050. */
const DUPLICATE_ID = '071452-2026';
/** Final accepted release of the chain in fetch order (page-111, last entry). */
const LAST_ACCEPTED = { id: '065395-2026', date: '2026-07-13T06:15:23+01:00' };

/** First-occurrence dedupe over fetch order — computed from the fixtures, not the implementation. */
function expectedAccepted(releases: ReleaseIdentity[]): ReleaseIdentity[] {
  const seen = new Set<string>();
  const out: ReleaseIdentity[] = [];
  for (const release of releases) {
    if (!seen.has(release.id)) {
      seen.add(release.id);
      out.push(release);
    }
  }
  return out;
}

async function runChainWalk(root: string, startMs: number) {
  const clock = makeVirtualClock(startMs);
  const { sleep, requested } = makeVirtualSleep(clock);
  const chain = wholeStreamChain();
  const { transport, calls } = makeFixtureTransport(chain.routes);
  const store = createRawStore(root, { now: clock.now });
  const summary = await ingestWindow(
    { transport, sleep, now: clock.now, store },
    { ...CHAIN_WINDOW },
  );
  return { summary, calls, sleeps: requested, clock, chain };
}

async function runRetryWalk(root: string, exchanges: RecordedExchange[]) {
  const clock = makeVirtualClock(T0);
  const { sleep, requested } = makeVirtualSleep(clock);
  const { transport, calls } = makeFixtureTransport({ [RETRY_URL]: exchanges });
  const store = createRawStore(root, { now: clock.now });
  const summary = await ingestWindow(
    { transport, sleep, now: clock.now, store },
    { ...RETRY_WINDOW },
  );
  return { summary, calls, sleeps: requested, clock };
}

describe('full walk over the recorded five-page chain', () => {
  let root: string;
  let walk: Awaited<ReturnType<typeof runChainWalk>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-ingest-'));
    walk = await runChainWalk(root, T0);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('constructs the first-page URL exactly as recorded (pinned parameter order)', () => {
    expect(walk.calls[0]).toBe(walk.chain.initialUrl);
    expect(walk.chain.initialUrl).toBe(
      `${BASE}?updatedFrom=2026-07-13T00:00:00&updatedTo=2026-08-12T00:00:00&limit=100`,
    );
  });

  it('follows links.next through all five pages and stops on the page with no links', () => {
    const expectedUrls = [
      walk.chain.initialUrl,
      ...walk.chain.pages.slice(0, -1).map((p) => p.pkg.links?.next),
    ];
    expect(expectedUrls).not.toContain(undefined);
    // Exactly five transport calls: termination is the absence of `links` on
    // page-111 (which still carries 37 releases), not an empty releases array.
    expect(walk.calls).toEqual(expectedUrls);
    expect(walk.summary.pages).toBe(5);
  });

  it('journals all five exchanges with increasing seq and matching URLs', () => {
    const http = httpRecords(root);
    expect(http).toHaveLength(5);
    expect(http.map((r) => r['url'])).toEqual(walk.calls);
    for (let i = 1; i < http.length; i++) {
      expect(http[i]?.['seq'] as number).toBeGreaterThan(http[i - 1]?.['seq'] as number);
    }
  });

  it('counts seen 437, accepted 436, alreadyPresent 0, quarantined 1', () => {
    expect(walk.summary.seen).toBe(437);
    expect(walk.summary.accepted).toBe(436);
    expect(walk.summary.alreadyPresent).toBe(0);
    expect(walk.summary.quarantined).toBe(1);
    // Real run-end reconciliation (Q-m3): assert the actual output, not
    // constant arithmetic. The duplicate-id is a RELEASE-level quarantine, so
    // it reconciles against `seen`; page-level quarantines are tracked apart in
    // `quarantinedPages` (none on this clean chain).
    expect(walk.summary.accepted + walk.summary.quarantined + walk.summary.alreadyPresent).toBe(
      walk.summary.seen,
    );
    expect(walk.summary.quarantinedPages ?? 0).toBe(0);
  });

  it('quarantines the page-050 duplicate as duplicate-id, not alreadyPresent', () => {
    // Binding addendum N1: the accepted-id snapshot is FROZEN at beginRun. An
    // implementation consulting a live store set absorbs the second
    // occurrence of 071452-2026 as alreadyPresent and must fail here.
    const entries = readQuarantine(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['reason']).toBe('duplicate-id');
    expect(JSON.stringify(entries[0])).toContain(DUPLICATE_ID);
    expect(walk.summary.alreadyPresent).toBe(0);
  });

  it('appends accepted releases in fetch order with identity-only fields', () => {
    const expected = expectedAccepted(walk.chain.releasesInFetchOrder);
    const lines = readReleases(root);
    expect(lines.map((l) => l['id'])).toEqual(expected.map((r) => r.id));
    for (const line of lines) {
      expect(line['ocid']).toMatch(/\S/);
      expect(line['bodyHash']).toMatch(/^[0-9a-f]{64}$/);
      expect(line['runId']).toMatch(/\S/);
      expect(line).not.toHaveProperty('date');
      expect(line).not.toHaveProperty('tag');
    }
    // Byte-fidelity spot checks at both ends of the walk: each accepted
    // release points at the hash of its page's raw bytes.
    expect(lines[0]?.['bodyHash']).toBe(sha256Hex(readFixtureBytes('whole-stream/page-001.json')));
    expect(lines[lines.length - 1]?.['bodyHash']).toBe(
      sha256Hex(readFixtureBytes('whole-stream/page-111.json')),
    );
  });

  it('requests a sleep of at least 13 s between every pair of page requests', () => {
    expect(walk.sleeps.length).toBeGreaterThanOrEqual(4);
    for (const ms of walk.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(13_000);
    }
  });

  it('stamps journal timestamps from the injected clock, advancing with the pacing', () => {
    // Binding addendum M1: each record's timestamp equals what the injected
    // clock returned at that point — presence alone is not enough.
    const returned = new Set(walk.clock.returned);
    for (const record of readJournal(root)) {
      expect(returned.has(record['epochMs'] as number)).toBe(true);
      expect(new Date(record['at'] as string).getTime()).toBe(record['epochMs']);
    }
    const stamps = httpRecords(root).map((r) => r['epochMs'] as number);
    expect(stamps).toHaveLength(5);
    // A build writing epochMs once at beginRun produces five identical
    // stamps and fails both of these.
    expect(new Set(stamps).size).toBe(5);
    for (let i = 1; i < stamps.length; i++) {
      expect((stamps[i] as number) - (stamps[i - 1] as number)).toBeGreaterThanOrEqual(13_000);
    }
  });

  it('stamps one non-empty runId across every journal record of the run', () => {
    const runIds = new Set(readJournal(root).map((r) => r['runId']));
    expect(runIds.size).toBe(1);
    const [runId] = runIds;
    expect(typeof runId).toBe('string');
    expect(runId).toMatch(/\S/);
  });

  it('records resume state as window + last-seen release, never the cursor (invariant #5)', () => {
    const runEnds = readJournal(root).filter((r) => r['kind'] === 'run-end');
    expect(runEnds).toHaveLength(1);
    const runEnd = runEnds[0];
    expect(runEnd?.['window']).toEqual(CHAIN_WINDOW);
    expect(runEnd?.['lastSeenRelease']).toEqual(LAST_ACCEPTED);
    expect(runEnd?.['ok']).toBe(true);
    expect(runEnd?.['seen']).toBe(437);
    expect(runEnd?.['accepted']).toBe(436);
    expect(runEnd?.['alreadyPresent']).toBe(0);
    expect(runEnd?.['quarantined']).toBe(1);
    // Cursors necessarily appear inside journaled URLs; the resume state
    // record must not carry one in any form (critique N2).
    expect(JSON.stringify(runEnd)).not.toMatch(/cursor/i);
  });
});

describe('idempotent re-run over the same store', () => {
  let root: string;
  let run1: Awaited<ReturnType<typeof runChainWalk>>;
  let run2: Awaited<ReturnType<typeof runChainWalk>>;
  let quarantineAfterRun1: Buffer;
  let releasesAfterRun1: Buffer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-ingest-'));
    run1 = await runChainWalk(root, T0);
    quarantineAfterRun1 = readFileSync(quarantinePath(root));
    releasesAfterRun1 = readFileSync(releasesPath(root));
    run2 = await runChainWalk(root, T0 + 86_400_000);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first run into a fresh store accepts 436 and quarantines the duplicate', () => {
    expect(run1.summary.seen).toBe(437);
    expect(run1.summary.accepted).toBe(436);
    expect(run1.summary.alreadyPresent).toBe(0);
    expect(run1.summary.quarantined).toBe(1);
  });

  it('second run accepts nothing and reports all 437 already present', () => {
    // Binding addendum N1: both occurrences of 071452-2026 resolve to the
    // frozen-snapshot case (case 2 precedes case 3) — alreadyPresent, not
    // quarantine. 0 + 437 + 0 = 437.
    expect(run2.summary.seen).toBe(437);
    expect(run2.summary.accepted).toBe(0);
    expect(run2.summary.alreadyPresent).toBe(437);
    expect(run2.summary.quarantined).toBe(0);
  });

  it('records the last release SEEN on the accept-nothing re-run, not null (invariant #5 resume state)', () => {
    // Item-8 decision: `lastSeenRelease` is the last release with a valid
    // identity ENCOUNTERED in the walk — accepted, already-present, or
    // duplicate alike — never null on a walk that saw releases. On the chain
    // the last valid release seen is the same 065395-2026 as run 1's last
    // accepted, so an accept-nothing re-run still carries usable resume state.
    // (Before the fix this was last-*accepted* and so null on run 2.)
    expect(run2.summary.accepted).toBe(0);
    expect(run2.summary.lastSeenRelease).toEqual(LAST_ACCEPTED);
    const runEnds = readJournal(root).filter((r) => r['kind'] === 'run-end');
    expect(runEnds[runEnds.length - 1]?.['lastSeenRelease']).toEqual(LAST_ACCEPTED);
  });

  it('second run leaves the quarantine file byte-for-byte unchanged', () => {
    expect(readQuarantine(root)).toHaveLength(1);
    expect(readFileSync(quarantinePath(root)).equals(quarantineAfterRun1)).toBe(true);
  });

  it('second run appends no release projection lines', () => {
    expect(readReleases(root)).toHaveLength(436);
    expect(readFileSync(releasesPath(root)).equals(releasesAfterRun1)).toBe(true);
  });

  it('still journals every exchange raw on the re-run, under a distinct runId', () => {
    // "Every response persisted raw" holds on re-runs too: 5 + 5 exchanges.
    const http = httpRecords(root);
    expect(http).toHaveLength(10);
    const runIds = [...new Set(readJournal(root).map((r) => r['runId']))];
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
  });
});

describe('Retry-After honoured — the real same-URL 429→200 pair (probe/20 → probe/22)', () => {
  let root: string;
  let walk: Awaited<ReturnType<typeof runRetryWalk>>;

  beforeAll(async () => {
    // Fixture sanity: both exchanges were recorded against the SAME URL, and
    // it is byte-for-byte the URL the core must construct for this window.
    const rateLimited = exchangeFromFixture(
      'probe/20-window-noZ-429.txt',
      'probe/20-window-noZ-429.headers',
    );
    const success = exchangeFromFixture('probe/22-window-noZ.json', 'probe/22-window-noZ.headers');
    const successPkg = JSON.parse(new TextDecoder().decode(success.body)) as PackagePage;
    expect(successPkg.uri).toBe(RETRY_URL);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers['retry-after']).toBe('120');

    root = await mkdtemp(join(tmpdir(), 'foretender-ingest-'));
    walk = await runRetryWalk(root, [rateLimited, success]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fetches the same URL exactly twice — retry, not pagination', () => {
    expect(walk.calls).toEqual([RETRY_URL, RETRY_URL]);
  });

  it('sleeps the Retry-After duration (120 s) before retrying', () => {
    expect(walk.sleeps).toContain(120_000);
    const [first, second] = httpRecords(root);
    expect((second?.['epochMs'] as number) - (first?.['epochMs'] as number)).toBeGreaterThanOrEqual(
      120_000,
    );
  });

  it('journals the 429 exchange raw: text/plain, 58 bytes, verbatim body, retryAfter 120', () => {
    const [rateLimited] = httpRecords(root);
    expect(rateLimited?.['status']).toBe(429);
    expect(rateLimited?.['contentType']).toBe('text/plain');
    expect(rateLimited?.['bodyBytes']).toBe(58);
    expect(Number(rateLimited?.['retryAfter'])).toBe(120);
    const stored = readFileSync(join(pagesDir(root), rateLimited?.['bodyHash'] as string));
    const fixture = readFixtureBytes('probe/20-window-noZ-429.txt');
    expect(Buffer.from(stored).equals(Buffer.from(fixture))).toBe(true);
  });

  it('never decodes the plain-text body as JSON and completes with all 43 releases', () => {
    // Observable form of "must not assume JSON" (invariant #3): the run
    // completes, nothing lands in quarantine, and the walk terminates on the
    // 200 page's absent links.
    expect(walk.summary.seen).toBe(43);
    expect(walk.summary.accepted).toBe(43);
    expect(walk.summary.alreadyPresent).toBe(0);
    expect(walk.summary.quarantined).toBe(0);
    expect(readQuarantine(root)).toHaveLength(0);
    expect(readReleases(root)).toHaveLength(43);
  });
});

describe('Retry-After absent', () => {
  it('defaults to a 30 s sleep on a 503 without Retry-After and retries the same URL', async () => {
    // SYNTHETIC 503 — no real 503 was recorded in the corpus (labelled
    // deviation from BUILD_BRIEF §9, plan Open questions). The 200 that
    // follows is the real probe/22 recording.
    const synthetic503: RecordedExchange = {
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode(
        'Service temporarily unavailable. SYNTHETIC FIXTURE: no recorded 503 exists.',
      ),
    };
    const success = exchangeFromFixture('probe/22-window-noZ.json', 'probe/22-window-noZ.headers');

    const root = await mkdtemp(join(tmpdir(), 'foretender-ingest-'));
    try {
      const walk = await runRetryWalk(root, [synthetic503, success]);
      expect(walk.sleeps).toContain(30_000);
      expect(walk.calls).toEqual([RETRY_URL, RETRY_URL]);
      expect(walk.summary.accepted).toBe(43);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('empty window', () => {
  it('completes on absence of links with zero releases (probe/24 body)', async () => {
    // probe/24 is a REAL empty 200 (releases: [], no links). Provenance: it
    // was recorded under a `stages=planning,tender` query the core is
    // forbidden to construct (invariant #1); it is reused here as an
    // empty-page BODY fixture only (plan step 1, critique N3).
    const window = { updatedFrom: '2026-08-10T00:00:00', updatedTo: '2026-08-11T00:00:00' };
    const url = `${BASE}?updatedFrom=2026-08-10T00:00:00&updatedTo=2026-08-11T00:00:00&limit=100`;
    const empty = exchangeFromFixture('probe/24-stages-combo.json', 'probe/24-stages-combo.headers');

    const root = await mkdtemp(join(tmpdir(), 'foretender-ingest-'));
    try {
      const clock = makeVirtualClock(T0);
      const { sleep } = makeVirtualSleep(clock);
      const { transport, calls } = makeFixtureTransport({ [url]: [empty] });
      const store = createRawStore(root, { now: clock.now });
      const summary = await ingestWindow({ transport, sleep, now: clock.now, store }, window);

      expect(calls).toHaveLength(1);
      expect(summary.pages).toBe(1);
      expect(summary.seen).toBe(0);
      expect(summary.accepted).toBe(0);
      expect(summary.alreadyPresent).toBe(0);
      expect(summary.quarantined).toBe(0);
      const runEnds = readJournal(root).filter((r) => r['kind'] === 'run-end');
      expect(runEnds).toHaveLength(1);
      expect(runEnds[0]?.['ok']).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('unparseable 200 body', () => {
  it('persists and journals the bytes before aborting, and quarantines unparseable-page', async () => {
    // SYNTHETIC body — the first 1000 bytes of the real page-001, which is
    // not valid JSON (labelled deviation: the corpus has zero malformed
    // payloads). Persist-raw-before-parse means the bytes and the journal
    // line must exist even though the run aborts.
    const truncated = readFixtureBytes('whole-stream/page-001.json').slice(0, 1000);
    const bodyHash = sha256Hex(truncated);
    const window = { updatedFrom: '2026-08-09T00:00:00', updatedTo: '2026-08-10T00:00:00' };
    const url = `${BASE}?updatedFrom=2026-08-09T00:00:00&updatedTo=2026-08-10T00:00:00&limit=100`;
    const exchange: RecordedExchange = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: truncated,
    };

    const root = await mkdtemp(join(tmpdir(), 'foretender-ingest-'));
    try {
      const clock = makeVirtualClock(T0);
      const { sleep } = makeVirtualSleep(clock);
      const { transport } = makeFixtureTransport({ [url]: [exchange] });
      const store = createRawStore(root, { now: clock.now });

      await expect(
        ingestWindow({ transport, sleep, now: clock.now, store }, window),
      ).rejects.toThrow();

      const http = httpRecords(root);
      expect(http).toHaveLength(1);
      expect(http[0]?.['bodyHash']).toBe(bodyHash);
      expect(http[0]?.['bodyBytes']).toBe(truncated.length);
      const stored = readFileSync(join(pagesDir(root), bodyHash));
      expect(Buffer.from(stored).equals(Buffer.from(truncated))).toBe(true);

      const entries = readQuarantine(root);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.['reason']).toBe('unparseable-page');
      expect(JSON.stringify(entries[0])).toContain(bodyHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('§5.3 replay through the ingest path', () => {
  it('re-runs a recorded walk through ingestWindow itself into an equivalent store', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'foretender-replay-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'foretender-replay-b-'));
    try {
      const original = await runChainWalk(rootA, T0);

      // Journal-backed transport from the source store (src/store/replay.ts
      // is product code — replay is a store capability, critique M3).
      const transport = createReplayTransport(rootA);
      const clock = makeVirtualClock(T0 + 7 * 86_400_000);
      const { sleep } = makeVirtualSleep(clock);
      const store = createRawStore(rootB, { now: clock.now });
      const replayed = await ingestWindow(
        { transport, sleep, now: clock.now, store },
        { ...CHAIN_WINDOW },
      );

      expect(replayed.seen).toBe(original.summary.seen);
      expect(replayed.accepted).toBe(original.summary.accepted);
      expect(replayed.alreadyPresent).toBe(original.summary.alreadyPresent);
      expect(replayed.quarantined).toBe(original.summary.quarantined);

      // Ordered projection equality after dropping ONLY the run-scoped
      // fields runId/at/epochMs — the documented ignore-list. Each ignored
      // field is pinned by its own test: presence/clock-fidelity in the
      // store contract, spacing and runId stability in the full-walk tests.
      expect(readReleases(rootB).map(dropRunScoped)).toEqual(
        readReleases(rootA).map(dropRunScoped),
      );
      expect(readQuarantine(rootB).map(dropRunScoped)).toEqual(
        readQuarantine(rootA).map(dropRunScoped),
      );
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });
});

describe('cross-run pacing from the journal (C-M1)', () => {
  it("paces the first request of a second run off the store's newest journaled request", async () => {
    // Invariant #3 spans runs, not just one walk: an immediate re-run must
    // still leave ≥13 s between the two runs' adjacent requests. Two chain
    // walks share one virtual clock; the operator "types" for 1 s between them.
    const root = await mkdtemp(join(tmpdir(), 'foretender-pacing-'));
    try {
      const clock = makeVirtualClock(T0);

      // Run 1 into a fresh store — its first request is unpaced.
      const s1 = makeVirtualSleep(clock);
      const chain1 = makeFixtureTransport(wholeStreamChain().routes);
      const store1 = createRawStore(root, { now: clock.now });
      await ingestWindow(
        { transport: chain1.transport, sleep: s1.sleep, now: clock.now, store: store1 },
        { ...CHAIN_WINDOW },
      );
      const http1 = httpRecords(root);
      const lastEpoch = http1[http1.length - 1]?.['epochMs'] as number;

      // 1 s of "operator typing", then an immediate re-run into the same store.
      clock.advance(1_000);
      const s2 = makeVirtualSleep(clock);
      const chain2 = makeFixtureTransport(wholeStreamChain().routes);
      const store2 = createRawStore(root, { now: clock.now });
      await ingestWindow(
        { transport: chain2.transport, sleep: s2.sleep, now: clock.now, store: store2 },
        { ...CHAIN_WINDOW },
      );

      // Run 2's FIRST sleep waits out the remainder of the 13 s floor measured
      // from run 1's last journaled request (13 000 − the 1 000 already elapsed).
      expect(s2.requested[0]).toBe(12_000);

      // The gap between run 1's last request and run 2's first request in the
      // journal is ≥13 s — the property the invariant states. (A fresh store,
      // by contrast, adds no such sleep: run 1's own first request was unpaced.)
      const http2 = httpRecords(root);
      const run2First = http2[5]?.['epochMs'] as number;
      expect(run2First - lastEpoch).toBeGreaterThanOrEqual(13_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('quarantine projection is idempotent across re-runs (C-M4)', () => {
  it('quarantines a synthetic malformed release once across two runs into one store', async () => {
    // SYNTHETIC malformed release — the corpus has zero malformed records
    // (plan step 4 precedent). `orphan-2` has an id but no ocid → identity
    // failure. Re-running the same window must NOT re-quarantine it: one
    // anomaly → one record, however many operator re-runs (C-M4). The counter
    // still counts the anomaly each run for reconciliation; the FILE dedupes.
    const window = { updatedFrom: '2026-08-08T00:00:00', updatedTo: '2026-08-09T00:00:00' };
    const url = `${BASE}?updatedFrom=2026-08-08T00:00:00&updatedTo=2026-08-09T00:00:00&limit=100`;
    const body = new TextEncoder().encode(
      JSON.stringify({
        uri: url,
        releases: [
          { id: 'valid-1', ocid: 'ocds-synthetic-valid-1' },
          { id: 'orphan-2' }, // SYNTHETIC: missing ocid → quarantine
        ],
      }),
    );
    const exchange: RecordedExchange = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    };

    const root = await mkdtemp(join(tmpdir(), 'foretender-quarantine-'));
    try {
      const runOnce = async (startMs: number) => {
        const clock = makeVirtualClock(startMs);
        const { sleep } = makeVirtualSleep(clock);
        const { transport } = makeFixtureTransport({ [url]: [exchange] });
        const store = createRawStore(root, { now: clock.now });
        return ingestWindow({ transport, sleep, now: clock.now, store }, window);
      };

      const s1 = await runOnce(T0);
      const s2 = await runOnce(T0 + 86_400_000);

      // Run 1 quarantines the anomaly and accepts the valid release.
      expect(s1.accepted).toBe(1);
      expect(s1.quarantined).toBe(1);
      // Run 2 sees both again: the valid one is already present, the malformed
      // one is counted (reconciliation) but appends no second record.
      expect(s2.accepted).toBe(0);
      expect(s2.alreadyPresent).toBe(1);
      expect(s2.quarantined).toBe(1);

      // Reconciliation holds on both runs.
      expect(s1.accepted + s1.quarantined + s1.alreadyPresent).toBe(s1.seen);
      expect(s2.accepted + s2.quarantined + s2.alreadyPresent).toBe(s2.seen);

      // The projection is idempotent: ONE quarantine record after both runs.
      const entries = readQuarantine(root);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.['reason']).toBe('missing-or-empty-ocid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
