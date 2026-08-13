import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRawStore } from '../src/store/raw-store.js';
import {
  exchangeFromFixture,
  readFixtureBytes,
  type RecordedExchange,
} from './helpers/fixture-transport.js';
import {
  ISO_WITH_OFFSET,
  checkpointsPath,
  httpRecords,
  journalPath,
  makeVirtualClock,
  pagesDir,
  readCheckpoints,
  readJournal,
  readQuarantine,
  readReleases,
  sha256Hex,
  type VirtualClock,
} from './helpers/support.js';

/**
 * Raw append-only store contract (brief req 3, BUILD_BRIEF §5.3, plan step 3),
 * plus the binding M1 addendum: runId present/non-empty/stable per run and
 * distinct across runs; at/epochMs FAITHFUL to the injected clock at each
 * record — a build stamping epochMs once at beginRun must fail here.
 *
 * Interface assumptions (see .harness/test-plan.md):
 *   createRawStore(rootDir: string, opts?: { now?: () => number })
 *   store.beginRun(window) / recordExchange(...) → { bodyHash } /
 *   snapshotIds() → Set<string> / addRelease({ id, ocid, bodyHash }) /
 *   quarantine(entry) / endRun(summary)
 * All methods are awaited so sync or async implementations both satisfy the
 * contract.
 */
const WINDOW = { updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' };
const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);
const UA = 'foretender/0.1 (contact: guyverhb@gmail.com)';

const PAGE_001_URL =
  'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom=2026-07-13T00:00:00&updatedTo=2026-08-12T00:00:00&limit=100';
const RETRY_URL =
  'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom=2026-08-11T16:00:00&updatedTo=2026-08-11T17:00:00&limit=100';

function exchangeArgs(exchange: RecordedExchange, url: string) {
  return {
    url,
    requestHeaders: { 'user-agent': UA },
    status: exchange.status,
    responseHeaders: exchange.headers,
    contentType: exchange.headers['content-type'] ?? '',
    body: exchange.body,
  };
}

function summaryFor(overrides: Record<string, unknown> = {}) {
  return {
    window: WINDOW,
    pages: 1,
    seen: 1,
    accepted: 1,
    alreadyPresent: 0,
    quarantined: 0,
    lastSeenRelease: { id: '076460-2026', date: '2026-08-11T23:36:44+01:00' },
    ok: true,
    ...overrides,
  };
}

describe('raw append-only store', () => {
  let root: string;
  let clock: VirtualClock;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-store-'));
    clock = makeVirtualClock(T0);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists response bodies byte-identical under their sha-256 content address', async () => {
    const bytes = readFixtureBytes('whole-stream/page-001.json');
    const exchange = exchangeFromFixture(
      'whole-stream/page-001.json',
      'whole-stream/page-001.headers',
    );
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    const { bodyHash } = await store.recordExchange(exchangeArgs(exchange, PAGE_001_URL));

    expect(bodyHash).toBe(sha256Hex(bytes));
    const stored = readFileSync(join(pagesDir(root), bodyHash));
    expect(Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true);
  });

  it('stores a body whose length equals the declared content-length (probe/20: 58)', async () => {
    const exchange = exchangeFromFixture(
      'probe/20-window-noZ-429.txt',
      'probe/20-window-noZ-429.headers',
    );
    // Sanity: the fixture really declares 58 — the only fixture that declares
    // a content-length at all (critique N3: keep this a test-only assertion).
    expect(exchange.headers['content-length']).toBe('58');

    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    const { bodyHash } = await store.recordExchange(exchangeArgs(exchange, RETRY_URL));

    expect(statSync(join(pagesDir(root), bodyHash)).size).toBe(58);
  });

  it('journals the 429 exchange with contentType text/plain and the verbatim body', async () => {
    const exchange = exchangeFromFixture(
      'probe/20-window-noZ-429.txt',
      'probe/20-window-noZ-429.headers',
    );
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    const { bodyHash } = await store.recordExchange(exchangeArgs(exchange, RETRY_URL));

    const [record] = httpRecords(root);
    expect(record).toBeDefined();
    expect(record?.['status']).toBe(429);
    expect(record?.['contentType']).toBe('text/plain');
    expect(record?.['bodyBytes']).toBe(58);
    expect(record?.['bodyHash']).toBe(bodyHash);
    expect(readFileSync(join(pagesDir(root), bodyHash), 'utf8')).toBe(
      'Rate limit of 12 exceeded. Please retry after 120 seconds.',
    );
  });

  it('carries kind, runId, at, epochMs and v on every journal record', async () => {
    const exchange = exchangeFromFixture(
      'whole-stream/page-001.json',
      'whole-stream/page-001.headers',
    );
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    await store.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    clock.advance(13_000);
    await store.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    await store.endRun(summaryFor());

    const journal = readJournal(root);
    expect(journal.length).toBeGreaterThanOrEqual(4); // run-start + 2 http + run-end
    for (const record of journal) {
      expect(record['kind']).toMatch(/\S/);
      expect(typeof record['runId']).toBe('string');
      expect(record['runId']).toMatch(/\S/);
      expect(typeof record['epochMs']).toBe('number');
      expect(record['at']).toMatch(ISO_WITH_OFFSET);
      expect(record['v']).toMatch(/\S/);
    }
    for (const record of httpRecords(root)) {
      expect(typeof record['seq']).toBe('number');
      expect(record['url']).toBe(PAGE_001_URL);
      expect(record['status']).toBe(200);
      expect(record['bodyHash']).toMatch(/^[0-9a-f]{64}$/);
      expect(record['bodyBytes']).toBe(exchange.body.length);
    }
  });

  it('stamps timestamps faithful to the injected clock — not once at beginRun', async () => {
    const exchange = exchangeFromFixture(
      'probe/22-window-noZ.json',
      'probe/22-window-noZ.headers',
    );
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    await store.recordExchange(exchangeArgs(exchange, RETRY_URL));
    clock.advance(13_000);
    await store.recordExchange(exchangeArgs(exchange, RETRY_URL));
    await store.endRun(summaryFor());

    const returned = new Set(clock.returned);
    for (const record of readJournal(root)) {
      // The value written is a value the injected clock actually returned…
      expect(returned.has(record['epochMs'] as number)).toBe(true);
      // …and `at` encodes the same instant.
      expect(new Date(record['at'] as string).getTime()).toBe(record['epochMs']);
    }
    const [first, second] = httpRecords(root);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The clock advanced 13 s between the two exchanges; a build that stamps
    // epochMs once at beginRun records a gap of 0 and fails here.
    expect((second?.['epochMs'] as number) - (first?.['epochMs'] as number)).toBe(13_000);
  });

  it('uses one non-empty runId per run, distinct between two runs of the same store', async () => {
    const exchange = exchangeFromFixture(
      'whole-stream/page-001.json',
      'whole-stream/page-001.headers',
    );
    const storeA = createRawStore(root, { now: clock.now });
    await storeA.beginRun(WINDOW);
    await storeA.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    await storeA.endRun(summaryFor());

    const runARecords = readJournal(root);
    const runAIds = new Set(runARecords.map((r) => r['runId']));
    expect(runAIds.size).toBe(1);
    const [runAId] = runAIds;
    expect(runAId).toMatch(/\S/);

    const storeB = createRawStore(root, { now: clock.now });
    await storeB.beginRun(WINDOW);
    await storeB.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    await storeB.endRun(summaryFor({ accepted: 0, alreadyPresent: 1 }));

    const runBRecords = readJournal(root).slice(runARecords.length);
    expect(runBRecords.length).toBeGreaterThanOrEqual(3);
    const runBIds = new Set(runBRecords.map((r) => r['runId']));
    expect(runBIds.size).toBe(1);
    const [runBId] = runBIds;
    expect(runBId).toMatch(/\S/);
    expect(runBId).not.toBe(runAId);
  });

  it('appends journal lines across store openings without rewriting earlier bytes', async () => {
    const exchange = exchangeFromFixture(
      'whole-stream/page-001.json',
      'whole-stream/page-001.headers',
    );
    const storeA = createRawStore(root, { now: clock.now });
    await storeA.beginRun(WINDOW);
    await storeA.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    await storeA.endRun(summaryFor());
    const before = readFileSync(journalPath(root));

    const storeB = createRawStore(root, { now: clock.now });
    await storeB.beginRun(WINDOW);
    await storeB.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    await storeB.endRun(summaryFor({ accepted: 0, alreadyPresent: 1 }));
    const after = readFileSync(journalPath(root));

    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
  });

  it('treats a repeated identical body as a body-file no-op while still journaling the exchange', async () => {
    const exchange = exchangeFromFixture(
      'whole-stream/page-001.json',
      'whole-stream/page-001.headers',
    );
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    const first = await store.recordExchange(exchangeArgs(exchange, PAGE_001_URL));
    clock.advance(13_000);
    const second = await store.recordExchange(exchangeArgs(exchange, PAGE_001_URL));

    expect(second.bodyHash).toBe(first.bodyHash);
    expect(readdirSync(pagesDir(root))).toHaveLength(1);
    expect(httpRecords(root)).toHaveLength(2);
  });

  it('freezes the accepted-id snapshot at beginRun (within-run adds are not visible)', async () => {
    // "Frozen" is load-bearing (critique N1): a live set here absorbs the
    // page-050 duplicate as alreadyPresent and brief req 6 loses its only
    // real test case.
    const bodyHash = sha256Hex(readFixtureBytes('whole-stream/page-001.json'));
    const storeA = createRawStore(root, { now: clock.now });
    await storeA.beginRun(WINDOW);
    await storeA.addRelease({ id: '076460-2026', ocid: 'ocds-h6vhtk-06e1e6', bodyHash });
    const during = await storeA.snapshotIds();
    expect(during.has('076460-2026')).toBe(false);
    await storeA.endRun(summaryFor());

    const storeB = createRawStore(root, { now: clock.now });
    await storeB.beginRun(WINDOW);
    const next = await storeB.snapshotIds();
    expect(next.has('076460-2026')).toBe(true);
  });

  it('appends an identity-only release projection: id, ocid, bodyHash, runId — no date, no tag', async () => {
    const bodyHash = sha256Hex(readFixtureBytes('whole-stream/page-001.json'));
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    await store.addRelease({ id: '076460-2026', ocid: 'ocds-h6vhtk-06e1e6', bodyHash });

    const lines = readReleases(root);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.['id']).toBe('076460-2026');
    expect(line?.['ocid']).toBe('ocds-h6vhtk-06e1e6');
    expect(line?.['bodyHash']).toBe(bodyHash);
    expect(line?.['runId']).toMatch(/\S/);
    expect(line).not.toHaveProperty('date');
    expect(line).not.toHaveProperty('tag');
  });

  it('appends quarantine entries with their reason, discarding nothing', async () => {
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    await store.quarantine({
      reason: 'duplicate-id',
      record: { id: '071452-2026', ocid: 'ocds-h6vhtk-0166cb' },
    });

    const entries = readQuarantine(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['reason']).toBe('duplicate-id');
    expect(JSON.stringify(entries[0])).toContain('071452-2026');
  });

  it('brackets the journal with a run-start carrying the window and a run-end carrying the summary', async () => {
    const store = createRawStore(root, { now: clock.now });
    await store.beginRun(WINDOW);
    await store.endRun(summaryFor({ pages: 0, seen: 0, accepted: 0 }));

    const journal = readJournal(root);
    const first = journal[0];
    const last = journal[journal.length - 1];
    expect(first?.['kind']).toBe('run-start');
    expect(first?.['window']).toEqual(WINDOW);
    expect(last?.['kind']).toBe('run-end');
    expect(last?.['window']).toEqual(WINDOW);
    expect(last?.['seen']).toBe(0);
    expect(last?.['accepted']).toBe(0);
    expect(last?.['alreadyPresent']).toBe(0);
    expect(last?.['quarantined']).toBe(0);
    expect(last?.['ok']).toBe(true);
    expect(last?.['lastSeenRelease']).toEqual({
      id: '076460-2026',
      date: '2026-08-11T23:36:44+01:00',
    });
  });

  // Day-completion checkpoint projection (plan step 3, the direct unit contract
  // the test-author delegated here). The record is written AFTER endRun, so it
  // must not depend on an active run; its identity is the `day` key alone; it
  // carries no runId (there is no live run at write time).
  const dayMeta = { window: WINDOW, accepted: 459, seen: 459, alreadyPresent: 0, quarantined: 0 };

  it('marks a day complete with NO active run and is idempotent by the day key', async () => {
    const store = createRawStore(root, { now: clock.now });
    // Deliberately no beginRun: a day-completion fact is recorded post-endRun.
    await store.markDayComplete('2026-08-10', dayMeta);
    expect((await store.completedDays()).has('2026-08-10')).toBe(true);
    expect(readCheckpoints(root)).toHaveLength(1);

    const afterFirst = readFileSync(checkpointsPath(root));
    // Re-marking the same day appends nothing — one record per day across calls.
    await store.markDayComplete('2026-08-10', dayMeta);
    expect(readCheckpoints(root)).toHaveLength(1);
    expect(readFileSync(checkpointsPath(root)).equals(afterFirst)).toBe(true);
  });

  it('re-scans completed days across store instances sharing a root', async () => {
    const storeA = createRawStore(root, { now: clock.now });
    await storeA.markDayComplete('2026-08-10', dayMeta);
    await storeA.markDayComplete('2026-08-11', { ...dayMeta, accepted: 496, seen: 496 });

    // A fresh instance sees both days (the set is read from disk, not memory).
    const storeB = createRawStore(root, { now: clock.now });
    expect(await storeB.completedDays()).toEqual(new Set(['2026-08-10', '2026-08-11']));
  });

  it('stamps the checkpoint faithful to the clock, keeps the metadata, and carries no runId', async () => {
    const store = createRawStore(root, { now: clock.now });
    clock.advance(5_000);
    await store.markDayComplete('2026-08-11', { ...dayMeta, accepted: 496, seen: 496 });

    const [record] = readCheckpoints(root);
    expect(record).toBeDefined();
    // The stamp is a value the injected clock actually returned, at encodes it.
    expect(new Set(clock.returned).has(record?.['epochMs'] as number)).toBe(true);
    expect(record?.['epochMs']).toBe(T0 + 5_000);
    expect(new Date(record?.['at'] as string).getTime()).toBe(record?.['epochMs']);
    expect(record?.['at']).toMatch(ISO_WITH_OFFSET);
    // Completion metadata is carried…
    expect(record?.['day']).toBe('2026-08-11');
    expect(record?.['window']).toEqual(WINDOW);
    expect(record?.['accepted']).toBe(496);
    expect(record?.['seen']).toBe(496);
    expect(record?.['alreadyPresent']).toBe(0);
    expect(record?.['quarantined']).toBe(0);
    expect(record?.['v']).toMatch(/\S/);
    // …but never a runId (there is no live run when a day is marked complete).
    expect(record).not.toHaveProperty('runId');
  });
});
