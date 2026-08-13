import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackfillError, runBackfill } from '../src/ingest/backfill.js';
import { createRawStore } from '../src/store/raw-store.js';
import {
  backfillRoutes,
  loadBackfillDay,
  makeFixtureTransport,
  type RecordedExchange,
} from './helpers/fixture-transport.js';
import {
  checkpointsPath,
  dropRunScoped,
  httpRecords,
  makeVirtualClock,
  makeVirtualSleep,
  readCheckpoints,
  readQuarantine,
  readReleases,
  releasesPath,
} from './helpers/support.js';

/**
 * Resumable multi-day backfill contract (brief reqs 3, 4, 5, 6, 7; plan step 7)
 * — fixture-only, zero network (injected transport + the setup.ts fetch poison).
 *
 * The three committed real day-walks (byte-exact per BUILD_BRIEF §9) are:
 *   2026-08-10 → 5 pages / 459 releases
 *   2026-08-11 → 5 pages / 496 releases
 *   2026-08-12 → 6 pages / 533 releases
 * disjoint (zero cross-day overlap), every entry has a non-empty id and ocid,
 * so a clean 3-day backfill is seen 1488 / accepted 1488 / alreadyPresent 0 /
 * quarantined 0 over 16 requests.
 *
 * The centrepiece is interrupt/resume (req 3/7): its "day 1 not re-fetched"
 * proof pairs (i) the resumed transport making NO day-1 request with (ii) the
 * first 459 release lines being a byte-identical prefix of the process-1
 * snapshot — (ii) alone cannot catch a re-fetch (the frozen dedupe snapshot
 * would report day-1 releases as alreadyPresent and append nothing), which is
 * exactly why (i) is retained (plan-critique round 2).
 *
 * Interface assumptions (see .harness/test-plan.md §Interface assumptions):
 *   runBackfill({ transport, sleep, now, store }, { from, to })
 *     → BackfillSummary {
 *         days: Array<{ day, window, skipped: boolean, summary: RunSummary|null }>,
 *         ingestedDays: number, skippedDays: number,
 *         seen, accepted, alreadyPresent, quarantined  // totals over ingested days
 *       }
 *   class BackfillError extends Error { readonly summary: BackfillSummary }
 *   store checkpoint projection: <root>/checkpoints.ndjson, one record per
 *     completed day keyed on `day`, carrying NO runId.
 *   loadBackfillDay(day) → { routes, initialUrl, releasesInFetchOrder, pages }
 *   backfillRoutes(days[]) → merged, collision-free route map.
 */
const BASE = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);

const FROM = '2026-08-10';
const TO = '2026-08-12';
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'] as const;

const DAY1_RELEASES = 459;
const DAY2_RELEASES = 496;
const DAY3_RELEASES = 533;
const TOTAL_RELEASES = 1488;

const DAY1_PAGES = 5;
const DAY2_PAGES = 5;
const DAY3_PAGES = 6;
const TOTAL_REQUESTS = 16;

/** Day 2 aborts after its first two pages in the mid-walk scenario. */
const DAY2_FIRST_TWO_PAGES_RELEASES = 200;

const DAY1_FIRST_URL = `${BASE}?updatedFrom=2026-08-10T00:00:00&updatedTo=2026-08-11T00:00:00&limit=100`;
const DAY2_FIRST_URL = `${BASE}?updatedFrom=2026-08-11T00:00:00&updatedTo=2026-08-12T00:00:00&limit=100`;
const DAY3_FIRST_URL = `${BASE}?updatedFrom=2026-08-12T00:00:00&updatedTo=2026-08-13T00:00:00&limit=100`;

/** URL substring identifying a request that belongs to a given day's window. */
const dayTag = (day: string): string => `updatedFrom=${day}T00:00:00`;
const callsForDay = (calls: string[], day: string): string[] =>
  calls.filter((u) => u.includes(dayTag(day)));

type BackfillResult = Awaited<ReturnType<typeof runBackfill>>;

/** One uninterrupted 3-day backfill into a fresh store on a single clock. */
async function runFullBackfill(
  root: string,
  startMs: number,
): Promise<{ result: BackfillResult; calls: string[] }> {
  const clock = makeVirtualClock(startMs);
  const { sleep } = makeVirtualSleep(clock);
  const { transport, calls } = makeFixtureTransport(backfillRoutes([...DAYS]));
  const store = createRawStore(root, { now: clock.now });
  const result = await runBackfill(
    { transport, sleep, now: clock.now, store },
    { from: FROM, to: TO },
  );
  return { result, calls };
}

describe('backfill fixtures route as recorded (multi-day helper sanity)', () => {
  it('loads each day with its recorded first-page URL, page count, and release count', () => {
    const d1 = loadBackfillDay('2026-08-10');
    const d2 = loadBackfillDay('2026-08-11');
    const d3 = loadBackfillDay('2026-08-12');

    expect(d1.initialUrl).toBe(DAY1_FIRST_URL);
    expect(d2.initialUrl).toBe(DAY2_FIRST_URL);
    expect(d3.initialUrl).toBe(DAY3_FIRST_URL);

    expect(d1.pages).toHaveLength(DAY1_PAGES);
    expect(d2.pages).toHaveLength(DAY2_PAGES);
    expect(d3.pages).toHaveLength(DAY3_PAGES);

    expect(d1.releasesInFetchOrder).toHaveLength(DAY1_RELEASES);
    expect(d2.releasesInFetchOrder).toHaveLength(DAY2_RELEASES);
    expect(d3.releasesInFetchOrder).toHaveLength(DAY3_RELEASES);
  });

  it('merges the three days into one collision-free route map (disjoint URL keyspaces)', () => {
    const merged = backfillRoutes([...DAYS]);
    const perDayKeys =
      Object.keys(loadBackfillDay('2026-08-10').routes).length +
      Object.keys(loadBackfillDay('2026-08-11').routes).length +
      Object.keys(loadBackfillDay('2026-08-12').routes).length;
    // No key shared across days: the merged map holds the exact sum of per-day
    // route counts, so days never collide when replayed together.
    expect(Object.keys(merged)).toHaveLength(perDayKeys);
  });
});

describe('full three-day backfill into a fresh store (req 7a)', () => {
  let root: string;
  let full: Awaited<ReturnType<typeof runFullBackfill>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-backfill-full-'));
    full = await runFullBackfill(root, T0);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ingests all three days in oldest-first order (req 6)', () => {
    expect(full.result.days.map((d) => d.day)).toEqual([...DAYS]);
    expect(full.result.ingestedDays).toBe(3);
    expect(full.result.skippedDays).toBe(0);
    for (const d of full.result.days) {
      expect(d.skipped).toBe(false);
    }
  });

  it('reports totals of seen 1488 / accepted 1488 / alreadyPresent 0 / quarantined 0', () => {
    expect(full.result.seen).toBe(TOTAL_RELEASES);
    expect(full.result.accepted).toBe(TOTAL_RELEASES);
    expect(full.result.alreadyPresent).toBe(0);
    expect(full.result.quarantined).toBe(0);
  });

  it('carries each day\'s own run summary with that day\'s accepted count (req 4, per day)', () => {
    const byDay = new Map(full.result.days.map((d) => [d.day, d]));
    expect(byDay.get('2026-08-10')?.summary?.accepted).toBe(DAY1_RELEASES);
    expect(byDay.get('2026-08-11')?.summary?.accepted).toBe(DAY2_RELEASES);
    expect(byDay.get('2026-08-12')?.summary?.accepted).toBe(DAY3_RELEASES);
  });

  it('writes all 1488 release projection lines and nothing to quarantine', () => {
    expect(readReleases(root)).toHaveLength(TOTAL_RELEASES);
    expect(readQuarantine(root)).toHaveLength(0);
  });

  it('marks all three days complete — one checkpoint record per day, keyed on day', () => {
    const checkpoints = readCheckpoints(root);
    expect(checkpoints.map((c) => c['day'])).toEqual([...DAYS]);
    expect(new Set(checkpoints.map((c) => c['day'])).size).toBe(3);
  });

  it('records completion metadata on the checkpoint but no runId (req 2)', () => {
    const checkpoints = readCheckpoints(root);
    const byDay = new Map(checkpoints.map((c) => [c['day'] as string, c]));
    expect(byDay.get('2026-08-10')?.['accepted']).toBe(DAY1_RELEASES);
    expect(byDay.get('2026-08-11')?.['accepted']).toBe(DAY2_RELEASES);
    expect(byDay.get('2026-08-12')?.['accepted']).toBe(DAY3_RELEASES);
    for (const c of checkpoints) {
      expect(c).not.toHaveProperty('runId');
    }
  });

  it('makes exactly 16 requests — five, five, six across the three day windows', () => {
    expect(full.calls).toHaveLength(TOTAL_REQUESTS);
    expect(httpRecords(root)).toHaveLength(TOTAL_REQUESTS);
    expect(callsForDay(full.calls, '2026-08-10')).toHaveLength(DAY1_PAGES);
    expect(callsForDay(full.calls, '2026-08-11')).toHaveLength(DAY2_PAGES);
    expect(callsForDay(full.calls, '2026-08-12')).toHaveLength(DAY3_PAGES);
  });

  it('keeps ≥13 s between every adjacent request, including both day boundaries (req 5)', () => {
    const stamps = httpRecords(root).map((r) => r['epochMs'] as number);
    expect(stamps).toHaveLength(TOTAL_REQUESTS);
    for (let i = 1; i < stamps.length; i++) {
      expect((stamps[i] as number) - (stamps[i - 1] as number)).toBeGreaterThanOrEqual(13_000);
    }
    // The two CROSS-DAY boundaries specifically: request 5→6 (day 1 → day 2)
    // and 10→11 (day 2 → day 3). These are paced off the store's journal floor,
    // not a within-day sleep — that carry-across is the point of req 5.
    const boundary1 = (stamps[DAY1_PAGES] as number) - (stamps[DAY1_PAGES - 1] as number);
    const boundary2 =
      (stamps[DAY1_PAGES + DAY2_PAGES] as number) -
      (stamps[DAY1_PAGES + DAY2_PAGES - 1] as number);
    expect(boundary1).toBeGreaterThanOrEqual(13_000);
    expect(boundary2).toBeGreaterThanOrEqual(13_000);
  });
});

describe('re-running an already-complete range is idempotent (req 4)', () => {
  let root: string;
  let releasesAfterFirst: Buffer;
  let checkpointsAfterFirst: Buffer;
  let rerun: { result: BackfillResult; calls: string[] };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-backfill-rerun-'));
    await runFullBackfill(root, T0);
    releasesAfterFirst = readFileSync(releasesPath(root));
    checkpointsAfterFirst = readFileSync(checkpointsPath(root));

    // Re-run the SAME range into the SAME store; a fresh clock a week later so
    // pacing is trivially satisfied (and would not have blocked anything, since
    // no request is made at all).
    const clock = makeVirtualClock(T0 + 7 * 86_400_000);
    const { sleep } = makeVirtualSleep(clock);
    const { transport, calls } = makeFixtureTransport(backfillRoutes([...DAYS]));
    const store = createRawStore(root, { now: clock.now });
    const result = await runBackfill(
      { transport, sleep, now: clock.now, store },
      { from: FROM, to: TO },
    );
    rerun = { result, calls };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ingests zero days and skips all three', () => {
    expect(rerun.result.ingestedDays).toBe(0);
    expect(rerun.result.skippedDays).toBe(3);
    expect(rerun.result.days.map((d) => d.day)).toEqual([...DAYS]);
    for (const d of rerun.result.days) {
      expect(d.skipped).toBe(true);
      expect(d.summary).toBeNull();
    }
  });

  it('reports zero new releases overall (req 4)', () => {
    expect(rerun.result.accepted).toBe(0);
    expect(rerun.result.seen).toBe(0);
    expect(rerun.result.alreadyPresent).toBe(0);
    expect(rerun.result.quarantined).toBe(0);
  });

  it('makes no HTTP request at all — every day is already complete', () => {
    expect(rerun.calls).toHaveLength(0);
  });

  it('leaves releases.ndjson and checkpoints.ndjson byte-for-byte unchanged', () => {
    expect(readReleases(root)).toHaveLength(TOTAL_RELEASES);
    expect(readFileSync(releasesPath(root)).equals(releasesAfterFirst)).toBe(true);
    expect(readFileSync(checkpointsPath(root)).equals(checkpointsAfterFirst)).toBe(true);
  });
});

describe('interrupt after day 1, resume, reach an equivalent store (req 3/7b)', () => {
  let root: string; // interrupted-then-resumed
  let uninterruptedRoot: string;

  let process1Error: unknown;
  let checkpointsAfterProcess1: string[];
  let releasesCountAfterProcess1: number;
  let day1Snapshot: Buffer;

  let resume: BackfillResult;
  let resumeCalls: string[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-backfill-interrupt-'));
    uninterruptedRoot = await mkdtemp(join(tmpdir(), 'foretender-backfill-uninterrupted-'));

    // ONE clock shared across BOTH processes, so cross-day pacing is real.
    const clock = makeVirtualClock(T0);

    // Process 1: transport holds ONLY day-1 routes. Day 1 completes; day 2's
    // first request has no fixture → ingestWindow aborts → runBackfill throws.
    const s1 = makeVirtualSleep(clock);
    const t1 = makeFixtureTransport(backfillRoutes(['2026-08-10']));
    const store1 = createRawStore(root, { now: clock.now });
    try {
      await runBackfill(
        { transport: t1.transport, sleep: s1.sleep, now: clock.now, store: store1 },
        { from: FROM, to: TO },
      );
    } catch (err) {
      process1Error = err;
    }
    checkpointsAfterProcess1 = readCheckpoints(root).map((c) => c['day'] as string);
    releasesCountAfterProcess1 = readReleases(root).length;
    day1Snapshot = readFileSync(releasesPath(root));

    // Operator gap, then Process 2 over the SAME store with all three days'
    // routes, on the SAME clock.
    clock.advance(1_000);
    const s2 = makeVirtualSleep(clock);
    const t2 = makeFixtureTransport(backfillRoutes([...DAYS]));
    const store2 = createRawStore(root, { now: clock.now });
    resume = await runBackfill(
      { transport: t2.transport, sleep: s2.sleep, now: clock.now, store: store2 },
      { from: FROM, to: TO },
    );
    resumeCalls = t2.calls;

    // Independent uninterrupted 3-day run for the equivalence comparison.
    await runFullBackfill(uninterruptedRoot, T0);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(uninterruptedRoot, { recursive: true, force: true });
  });

  it('process 1 fails with a BackfillError after completing only day 1', () => {
    expect(process1Error).toBeInstanceOf(BackfillError);
    expect(checkpointsAfterProcess1).toEqual(['2026-08-10']);
    expect(releasesCountAfterProcess1).toBe(DAY1_RELEASES);
  });

  it('the day-1 snapshot holds exactly the 459 day-1 release lines (the byte-prefix oracle)', () => {
    const lines = day1Snapshot
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(DAY1_RELEASES);
  });

  it('resume re-fetches NO day-1 request — the checkpoint skips it (req 3a)', () => {
    // Direct evidence for "not re-fetched": no request in day 1's window.
    expect(callsForDay(resumeCalls, '2026-08-10')).toHaveLength(0);
    // It DOES fetch the remaining days.
    expect(callsForDay(resumeCalls, '2026-08-11')).toHaveLength(DAY2_PAGES);
    expect(callsForDay(resumeCalls, '2026-08-12')).toHaveLength(DAY3_PAGES);
  });

  it('resume marks day 1 skipped and ingests days 2 and 3', () => {
    expect(resume.days.map((d) => d.day)).toEqual([...DAYS]);
    const day1 = resume.days.find((d) => d.day === '2026-08-10');
    expect(day1?.skipped).toBe(true);
    expect(day1?.summary).toBeNull();
    expect(resume.days.find((d) => d.day === '2026-08-11')?.skipped).toBe(false);
    expect(resume.days.find((d) => d.day === '2026-08-12')?.skipped).toBe(false);
    expect(resume.ingestedDays).toBe(2);
    expect(resume.skippedDays).toBe(1);
  });

  it('resume ingest totals cover only the re-run days 2 and 3', () => {
    expect(resume.seen).toBe(DAY2_RELEASES + DAY3_RELEASES);
    expect(resume.accepted).toBe(DAY2_RELEASES + DAY3_RELEASES);
    expect(resume.alreadyPresent).toBe(0);
    expect(resume.quarantined).toBe(0);
  });

  it('keeps the day-1 bytes verbatim as the prefix of the final projection (req 3, append-only)', () => {
    // Append-only: the first 459 lines are physically process 1's bytes, never
    // rewritten by the resume. This corroborates the "no re-fetch" evidence
    // above — but on its own could NOT catch a re-fetch (the frozen dedupe
    // snapshot would absorb day-1 releases as alreadyPresent and append
    // nothing), which is why the no-day-1-request check is kept alongside it.
    const finalReleases = readFileSync(releasesPath(root));
    expect(finalReleases.length).toBeGreaterThan(day1Snapshot.length);
    expect(finalReleases.subarray(0, day1Snapshot.length).equals(day1Snapshot)).toBe(true);
    expect(readReleases(root)).toHaveLength(TOTAL_RELEASES);
  });

  it('reaches a store equivalent to an uninterrupted three-day run (req 3c/7)', () => {
    // Release projection: identical in order after dropping run-scoped fields.
    expect(readReleases(root).map(dropRunScoped)).toEqual(
      readReleases(uninterruptedRoot).map(dropRunScoped),
    );
    // Quarantine: identical (both empty) after dropping run-scoped fields.
    expect(readQuarantine(root).map(dropRunScoped)).toEqual(
      readQuarantine(uninterruptedRoot).map(dropRunScoped),
    );
    // Completed-day SET equality — checkpoint records legitimately differ in
    // at/epochMs, so compare day keys, never whole records.
    expect(new Set(readCheckpoints(root).map((c) => c['day']))).toEqual(
      new Set(readCheckpoints(uninterruptedRoot).map((c) => c['day'])),
    );
    expect(readReleases(root)).toHaveLength(TOTAL_RELEASES);
    expect(readReleases(uninterruptedRoot)).toHaveLength(TOTAL_RELEASES);
  });
});

describe('a day interrupted mid-walk is not marked complete and is re-run in full (req 3)', () => {
  let root: string; // interrupted-mid-day-then-resumed
  let uninterruptedRoot: string;

  let process1Error: unknown;
  let checkpointsAfterProcess1: string[];
  let releasesCountAfterProcess1: number;

  let resume: BackfillResult;
  let resumeCalls: string[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-backfill-midwalk-'));
    uninterruptedRoot = await mkdtemp(join(tmpdir(), 'foretender-backfill-midwalk-ref-'));

    const clock = makeVirtualClock(T0);

    // Process 1: full day 1 + ONLY the first two pages of day 2. Day 2 walks
    // page 1 and page 2 (200 releases appended), then requests page 3 → no
    // fixture → aborts MID-WALK. Day 2 must NOT be marked complete.
    const day2 = loadBackfillDay('2026-08-11');
    const [p1, p2] = day2.pages;
    if (p1 === undefined || p2 === undefined) {
      throw new Error('day-2 fixture is missing its first two pages');
    }
    const p1Next = p1.pkg.links?.next;
    if (p1Next === undefined) {
      throw new Error('day-2 page-001 has no links.next to chain from');
    }
    const day2FirstTwoPages: Record<string, RecordedExchange[]> = {
      [day2.initialUrl]: [p1.exchange],
      [p1Next]: [p2.exchange],
    };
    const process1Routes = { ...backfillRoutes(['2026-08-10']), ...day2FirstTwoPages };

    const s1 = makeVirtualSleep(clock);
    const t1 = makeFixtureTransport(process1Routes);
    const store1 = createRawStore(root, { now: clock.now });
    try {
      await runBackfill(
        { transport: t1.transport, sleep: s1.sleep, now: clock.now, store: store1 },
        { from: FROM, to: TO },
      );
    } catch (err) {
      process1Error = err;
    }
    checkpointsAfterProcess1 = readCheckpoints(root).map((c) => c['day'] as string);
    releasesCountAfterProcess1 = readReleases(root).length;

    // Resume with all three days' full routes on the same clock.
    clock.advance(1_000);
    const s2 = makeVirtualSleep(clock);
    const t2 = makeFixtureTransport(backfillRoutes([...DAYS]));
    const store2 = createRawStore(root, { now: clock.now });
    resume = await runBackfill(
      { transport: t2.transport, sleep: s2.sleep, now: clock.now, store: store2 },
      { from: FROM, to: TO },
    );
    resumeCalls = t2.calls;

    await runFullBackfill(uninterruptedRoot, T0);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(uninterruptedRoot, { recursive: true, force: true });
  });

  it('leaves day 2 unmarked despite persisting 200 of its releases before the abort', () => {
    expect(process1Error).toBeInstanceOf(BackfillError);
    // Only day 1 is complete; the partially-walked day 2 is deliberately absent
    // from the checkpoint — a partial day is never treated as done.
    expect(checkpointsAfterProcess1).toEqual(['2026-08-10']);
    // 459 (day 1) + 200 (day 2 pages 1–2) persisted — partial data is KEPT,
    // not discarded; there is no partial-day state to reconcile.
    expect(releasesCountAfterProcess1).toBe(DAY1_RELEASES + DAY2_FIRST_TWO_PAGES_RELEASES);
  });

  it('re-runs the incomplete day in full on resume — a partial day is never skipped (req 3)', () => {
    // Day 1 (complete) is skipped; day 2 (incomplete) IS re-fetched in full.
    expect(callsForDay(resumeCalls, '2026-08-10')).toHaveLength(0);
    expect(callsForDay(resumeCalls, '2026-08-11')).toHaveLength(DAY2_PAGES);
    expect(callsForDay(resumeCalls, '2026-08-12')).toHaveLength(DAY3_PAGES);
    expect(resume.days.find((d) => d.day === '2026-08-11')?.skipped).toBe(false);
  });

  it('reconciles the partial day idempotently: 200 already present, 296 newly accepted', () => {
    const day2 = resume.days.find((d) => d.day === '2026-08-11');
    expect(day2?.summary?.seen).toBe(DAY2_RELEASES);
    expect(day2?.summary?.accepted).toBe(DAY2_RELEASES - DAY2_FIRST_TWO_PAGES_RELEASES);
    expect(day2?.summary?.alreadyPresent).toBe(DAY2_FIRST_TWO_PAGES_RELEASES);
    expect(day2?.summary?.quarantined).toBe(0);
  });

  it('completes the range with no duplicated releases and one checkpoint per day', () => {
    expect(readReleases(root)).toHaveLength(TOTAL_RELEASES);
    expect(readCheckpoints(root).map((c) => c['day'])).toEqual([...DAYS]);
    // Day 2 is recorded exactly once even though it was walked across two runs.
    expect(readCheckpoints(root).filter((c) => c['day'] === '2026-08-11')).toHaveLength(1);
  });

  it('reaches a store equivalent to an uninterrupted run (idempotent by dedupe, req 3c)', () => {
    expect(readReleases(root).map(dropRunScoped)).toEqual(
      readReleases(uninterruptedRoot).map(dropRunScoped),
    );
    expect(new Set(readCheckpoints(root).map((c) => c['day']))).toEqual(
      new Set(readCheckpoints(uninterruptedRoot).map((c) => c['day'])),
    );
  });
});
