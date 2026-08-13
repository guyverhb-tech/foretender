/**
 * I-M1 regression test (belongs to plan step 5's §5.3 replay bullet).
 *
 * The append-only journal holds one run per recorded day (brief req 4 re-runs
 * into the same store, plan:174-178 runs the CLI twice), so a multi-run store
 * exists from the first QA session on. `createReplayTransport` must therefore
 * be able to replay ANY run, not just the first: it scopes the exchange list
 * to a single run (the newest by default, or an explicit `runId`).
 *
 * This file previously asserted the *defect* (run B diverges at exchange 1,
 * run A succeeds silently). It is rewritten in place to assert the fix: run B
 * replays correctly and run A remains replayable via its runId. The two-run
 * store fixture (run A = chain, run B = retry) is kept — it is exactly the
 * state the fix must handle.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ingestWindow } from '../src/ingest/ingest.js';
import { createRawStore } from '../src/store/raw-store.js';
import { createReplayTransport } from '../src/store/replay.js';
import {
  exchangeFromFixture,
  makeFixtureTransport,
  wholeStreamChain,
} from './helpers/fixture-transport.js';
import {
  makeVirtualClock,
  makeVirtualSleep,
  httpRecords,
  readJournal,
} from './helpers/support.js';

const BASE = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);

const CHAIN_WINDOW = { updatedFrom: '2026-07-13T00:00:00', updatedTo: '2026-08-12T00:00:00' };
const RETRY_WINDOW = { updatedFrom: '2026-08-11T16:00:00', updatedTo: '2026-08-11T17:00:00' };
const RETRY_URL = `${BASE}?updatedFrom=2026-08-11T16:00:00&updatedTo=2026-08-11T17:00:00&limit=100`;

describe('I-M1 regression: createReplayTransport selects a run in a multi-run store', () => {
  let root: string;
  let runAId: string;
  let runBId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-i-m1-'));

    // Run A: chain walk (5 exchanges).
    const clock1 = makeVirtualClock(T0);
    const { sleep: sleep1 } = makeVirtualSleep(clock1);
    const chain = wholeStreamChain();
    const { transport: transport1 } = makeFixtureTransport(chain.routes);
    const store1 = createRawStore(root, { now: clock1.now });
    await ingestWindow(
      { transport: transport1, sleep: sleep1, now: clock1.now, store: store1 },
      { ...CHAIN_WINDOW },
    );

    // Run B: retry window (2 exchanges — the real 429 then the 200).
    const clock2 = makeVirtualClock(T0);
    const { sleep: sleep2 } = makeVirtualSleep(clock2);
    const rateLimited = exchangeFromFixture(
      'probe/20-window-noZ-429.txt',
      'probe/20-window-noZ-429.headers',
    );
    const success = exchangeFromFixture('probe/22-window-noZ.json', 'probe/22-window-noZ.headers');
    const { transport: transport2 } = makeFixtureTransport({ [RETRY_URL]: [rateLimited, success] });
    const store2 = createRawStore(root, { now: clock2.now });
    await ingestWindow(
      { transport: transport2, sleep: sleep2, now: clock2.now, store: store2 },
      { ...RETRY_WINDOW },
    );

    const runIds = [...new Set(readJournal(root).map((r) => r['runId'] as string))];
    expect(runIds).toHaveLength(2);
    [runAId, runBId] = runIds as [string, string];
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('store contains 2 distinct runs', () => {
    const runIds = [...new Set(readJournal(root).map((r) => r['runId']))];
    expect(runIds).toHaveLength(2);
  });

  it('store has 7 total http records (5 from run A, 2 from run B including the 429)', () => {
    expect(httpRecords(root)).toHaveLength(7);
  });

  it('a default replay is scoped to the newest run only (run B), not concatenated across runs', async () => {
    // After the fix, replay filters by runId (newest by default), not by
    // position across all 7 records: run B has exactly 2 exchanges and does
    // not leak into run A's five.
    const transport = createReplayTransport(root);
    const first = await transport(RETRY_URL);
    expect(first.status).toBe(429); // run B's first exchange, not run A's page-001
    const second = await transport(RETRY_URL);
    expect(second.status).toBe(200);
    await expect(transport(RETRY_URL)).rejects.toThrow(/exhausted after 2 exchange/);
  });

  it('replays the newest run (run B, the retry window) correctly by default', async () => {
    const replayStore = await mkdtemp(join(tmpdir(), 'foretender-i-m1-replay-b-'));
    try {
      const transport = createReplayTransport(root); // default → newest run = run B
      const clock = makeVirtualClock(T0);
      const { sleep } = makeVirtualSleep(clock);
      const store = createRawStore(replayStore, { now: clock.now });

      const summary = await ingestWindow(
        { transport, sleep, now: clock.now, store },
        { ...RETRY_WINDOW },
      );

      // The 429 is retried, the 200 yields 43 releases, and the walk
      // terminates on the 200 page's absent `links`.
      expect(summary.pages).toBe(1);
      expect(summary.seen).toBe(43);
      expect(summary.accepted).toBe(43);
      expect(summary.quarantined).toBe(0);
      expect(summary.ok).toBe(true);
    } finally {
      await rm(replayStore, { recursive: true, force: true });
    }
  });

  it('replays run A (the chain window) when its runId is selected explicitly', async () => {
    const replayStore = await mkdtemp(join(tmpdir(), 'foretender-i-m1-replay-a-'));
    try {
      const transport = createReplayTransport(root, { runId: runAId });
      const clock = makeVirtualClock(T0);
      const { sleep } = makeVirtualSleep(clock);
      const store = createRawStore(replayStore, { now: clock.now });

      const summary = await ingestWindow(
        { transport, sleep, now: clock.now, store },
        { ...CHAIN_WINDOW },
      );

      expect(summary.pages).toBe(5);
      expect(summary.seen).toBe(437);
      expect(summary.accepted).toBe(436);
      expect(summary.quarantined).toBe(1);
      expect(summary.ok).toBe(true);
    } finally {
      await rm(replayStore, { recursive: true, force: true });
    }
  });

  it('names the run and the run count when an unknown runId is requested', () => {
    expect(() => createReplayTransport(root, { runId: 'no-such-run' })).toThrow(
      /no run «no-such-run».*holds 2 run/,
    );
    // Distinct real runIds exist for the two recorded runs.
    expect(runAId).not.toBe(runBId);
  });
});
