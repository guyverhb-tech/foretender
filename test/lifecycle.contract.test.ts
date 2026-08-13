import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestWindow } from '../src/ingest/ingest.js';
import {
  createRawStore,
  readAcceptedReleases,
  readPageBody,
} from '../src/store/raw-store.js';
import type { AcceptedRelease } from '../src/store/raw-store.js';
import { toLifecycleEvent } from '../src/lifecycle/event.js';
import { reconstructMany, reconstructOne, sortEvents } from '../src/lifecycle/machine.js';
import { projectLifecycles } from '../src/lifecycle/project.js';
import type { Lifecycle, LifecycleEvent, LifecycleSummary } from '../src/lifecycle/model.js';
import {
  loadBackfillDay,
  makeFixtureTransport,
  wholeStreamChain,
} from './helpers/fixture-transport.js';
import { makeVirtualClock, makeVirtualSleep, readNdjson } from './helpers/support.js';

/**
 * Lifecycle state-machine contract (brief reqs 2–6; invariants #6–#8, #14–#15;
 * plan steps 3–6) — fixture-only, zero network. The store is built through the
 * injected fixture transport; the setup.ts globalThis.fetch poison is the
 * backstop, so any accidental wire touch fails loudly.
 *
 * TWO LOAD-BEARING PROPERTIES this suite must bite on:
 *
 *   ORDER-INDEPENDENCE (§11). `reconstructOne` sorts canonically then folds, so
 *   the SAME event set in ANY input permutation must produce bit-identical
 *   output. Proven by deterministically permuting (reverse + fixed rotations) the
 *   real event arrays of `06b607`, `05495a`, and the 37-notice `060882` and
 *   asserting deep-equality against the sorted fold. Backed by a `sortEvents`
 *   total-order unit and a `reconstructMany` ocid-ascending grouping test.
 *
 *   §5.4 DIRTY-REALITY ANOMALIES. Each class is a distinct, recorded anomaly
 *   with a stable reason — never a crash or a silent coercion. `out-of-order`
 *   (06e072), `contradiction` (05495a), and `duplicate` (pure-machine witness)
 *   each fire; orphan-base and skipped-stage are recorded as NORMAL attributes,
 *   NOT anomalies, keeping the rate an honest health metric.
 *
 * All integers below are the test-author's disk-derived ground truth,
 * independently recomputed by reimplementing the plan's Step-3 fold over every
 * committed fixture (see .harness/test-plan.md). They match the orchestrator's
 * plan-critique recompute to the integer. The builder's fold MUST reproduce them.
 *
 * Interface assumptions (see .harness/test-plan.md §Interface assumptions):
 *   toLifecycleEvent(release: unknown): LifecycleEvent
 *   sortEvents(events: LifecycleEvent[]): LifecycleEvent[]
 *   reconstructOne(events: LifecycleEvent[]): Lifecycle
 *   reconstructMany(events: LifecycleEvent[]): Lifecycle[]   // sorted by ocid asc
 *   projectLifecycles(rootDir: string): LifecycleSummary     // synchronous full rebuild
 *   store siblings <root>/lifecycles.ndjson, <root>/lifecycle-anomalies.ndjson
 */

type Json = Record<string, unknown>;

const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);

/** The whole-stream chain's window is page-001's own `uri` window. */
const WHOLE_STREAM_WINDOW = {
  updatedFrom: '2026-07-13T00:00:00',
  updatedTo: '2026-08-12T00:00:00',
};
/** Each committed backfill day walks a one-London-day window. */
const DAY_WINDOWS: Record<string, { updatedFrom: string; updatedTo: string }> = {
  '2026-08-10': { updatedFrom: '2026-08-10T00:00:00', updatedTo: '2026-08-11T00:00:00' },
  '2026-08-11': { updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' },
  '2026-08-12': { updatedFrom: '2026-08-12T00:00:00', updatedTo: '2026-08-13T00:00:00' },
};
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'] as const;

/** Every committed ocid shares this prefix (verified over the corpus). */
const oc = (suffix: string): string => `ocds-h6vhtk-${suffix}`;

const lifecyclesPath = (root: string): string => join(root, 'lifecycles.ndjson');
const anomaliesPath = (root: string): string => join(root, 'lifecycle-anomalies.ndjson');
const readBytesOrEmpty = (p: string): Buffer => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));

/**
 * Build ONE temp store from the committed fixtures exactly as the tender
 * contract test does: ingest the whole-stream chain then each backfill day on
 * one shared virtual clock (cross-run pacing is real but instantaneous under
 * virtual sleep). Dedupe is the store's own frozen-snapshot dedupe on release
 * `id` — the whole-stream ∩ backfill window overlap collapses 1925 raw release
 * entries to 1624 distinct releases.
 */
async function buildCorpusStore(root: string): Promise<void> {
  const clock = makeVirtualClock(T0);
  const { sleep } = makeVirtualSleep(clock);

  {
    const chain = wholeStreamChain();
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...WHOLE_STREAM_WINDOW });
  }
  for (const day of DAYS) {
    const chain = loadBackfillDay(day);
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    const window = DAY_WINDOWS[day];
    if (window === undefined) throw new Error(`no window for day ${day}`);
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...window });
  }
}

/**
 * Collect the lifecycle events for ONE ocid, independently of the projection's
 * grouping: read the store's accepted releases, filter to the ocid, dedup by
 * release id, and map each raw body through `toLifecycleEvent`. This yields the
 * event array in store order — the raw material for order-independence, which is
 * a property of `reconstructOne` over the event SET regardless of arrival order.
 */
function eventsForOcid(root: string, ocid: string): LifecycleEvent[] {
  const accepted: AcceptedRelease[] = readAcceptedReleases(root);
  const cache = new Map<string, { releases?: Json[] }>();
  const seen = new Set<string>();
  const events: LifecycleEvent[] = [];
  for (const rec of accepted) {
    if (rec.ocid !== ocid) continue;
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    let pkg = cache.get(rec.bodyHash);
    if (pkg === undefined) {
      pkg = JSON.parse(new TextDecoder().decode(readPageBody(root, rec.bodyHash))) as {
        releases?: Json[];
      };
      cache.set(rec.bodyHash, pkg);
    }
    const rel = (pkg.releases ?? []).find((r) => r['id'] === rec.id);
    if (rel === undefined) throw new Error(`release ${rec.id} not found in page ${rec.bodyHash}`);
    events.push(toLifecycleEvent(rel));
  }
  return events;
}

/** A hand-built lifecycle event for the pure-machine unit witnesses. */
function ev(ocid: string, releaseId: string, tag: string[]): LifecycleEvent {
  return { ocid, releaseId, tag, noticeType: null, date: null, regime: null };
}

const reversed = <T>(a: readonly T[]): T[] => [...a].reverse();
const rotated = <T>(a: readonly T[], k: number): T[] => {
  if (a.length === 0) return [];
  const n = ((k % a.length) + a.length) % a.length;
  return [...a.slice(n), ...a.slice(0, n)];
};

describe('lifecycle reconstruction over the committed corpus (§5.4, §11, §5.3)', () => {
  let root: string;
  let summary: LifecycleSummary;
  let byOcid: Map<string, Lifecycle>;
  let flat: Array<Record<string, unknown>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-lifecycle-'));
    await buildCorpusStore(root);
    summary = projectLifecycles(root);
    const records = readNdjson(lifecyclesPath(root)) as unknown as Lifecycle[];
    byOcid = new Map(records.map((r) => [r.ocid, r]));
    flat = readNdjson(anomaliesPath(root));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const lifecycleFor = (ocid: string): Lifecycle => {
    const lc = byOcid.get(ocid);
    if (lc === undefined) throw new Error(`no lifecycle projected for ${ocid}`);
    return lc;
  };

  describe('population + state distribution (plan step 6 — pinned before any witness)', () => {
    it('projects 1492 ocids over 1624 deduped events', () => {
      expect(summary.ocids).toBe(1492);
      expect(summary.events).toBe(1624);
    });

    it('reports the exact state distribution (unknown seeded at 0)', () => {
      expect(summary.stateDistribution).toEqual({
        pipeline: 164,
        tender: 280,
        awarded: 1016,
        cancelled: 20,
        terminated: 12,
        unknown: 0,
      });
      const total = Object.values(summary.stateDistribution).reduce((a, b) => a + b, 0);
      expect(total).toBe(summary.ocids);
    });

    it('splits the regime the same way (1286 UKPGA / 206 CELEX = 1492)', () => {
      expect(summary.regime.UKPGA).toBe(1286);
      expect(summary.regime.CELEX).toBe(206);
      expect(summary.regime.UKPGA + summary.regime.CELEX).toBe(summary.ocids);
    });

    it('dedups release ids across the whole-stream ∩ backfill overlap (no double-count)', () => {
      // Store frozen-snapshot dedupe + the projection's defensive dedup-by-id
      // collapse 1925 raw release entries to 1624 distinct events. events must
      // equal the store's unique accepted count, never inflate it.
      const accepted = readAcceptedReleases(root);
      expect(new Set(accepted.map((r) => r.id)).size).toBe(accepted.length);
      expect(accepted.length).toBe(1624);
      expect(summary.events).toBe(accepted.length);
    });
  });

  describe('clean-sequence witnesses fold to their pinned state (empty anomalies)', () => {
    it('06e0a7 tender→tenderUpdate stays tender, amendmentCount 1', () => {
      const lc = lifecycleFor(oc('06e0a7'));
      expect(lc.state).toBe('tender');
      expect(lc.amendmentCount).toBe(1);
      expect(lc.orphanBase).toBe(false);
      expect(lc.skippedStages).toBe(false);
      expect(lc.anomalies).toEqual([]);
    });

    it('06df9d planning→planningUpdate stays pipeline, amendmentCount 1', () => {
      const lc = lifecycleFor(oc('06df9d'));
      expect(lc.state).toBe('pipeline');
      expect(lc.amendmentCount).toBe(1);
      expect(lc.orphanBase).toBe(false);
      expect(lc.skippedStages).toBe(false);
      expect(lc.anomalies).toEqual([]);
    });

    it('06e068 tender→award advances to awarded, amendmentCount 0', () => {
      const lc = lifecycleFor(oc('06e068'));
      expect(lc.state).toBe('awarded');
      expect(lc.amendmentCount).toBe(0);
      expect(lc.anomalies).toEqual([]);
    });

    it('06b607 planningUpdate→tender→tenderUpdate → tender, amendmentCount 2, orphanBase', () => {
      const lc = lifecycleFor(oc('06b607'));
      expect(lc.state).toBe('tender');
      expect(lc.amendmentCount).toBe(2);
      expect(lc.orphanBase).toBe(true); // first event is an update whose base predates the window
      expect(lc.skippedStages).toBe(false);
      expect(lc.anomalies).toEqual([]);
    });

    it('05250a planningUpdate→tenderCancellation → cancelled, amendmentCount 1, skippedStages', () => {
      const lc = lifecycleFor(oc('05250a'));
      expect(lc.state).toBe('cancelled');
      expect(lc.amendmentCount).toBe(1);
      expect(lc.skippedStages).toBe(true); // cancellation skips the tender stage — NORMAL
      expect(lc.orphanBase).toBe(true); // first event is a planningUpdate (an amend)
      expect(lc.anomalies).toEqual([]);
    });

    // Regression for C-B1: a release's tag[] is a SET, so a combined
    // planning,tender release is a live TENDER (max rank over its stage tags),
    // never pipeline (the first-listed tag). Independent of tag/input order.
    it('06e193 dual planning,tender single-release ocid folds to tender (not pipeline)', () => {
      const lc = lifecycleFor(oc('06e193'));
      expect(lc.state).toBe('tender');
      expect(lc.history).toHaveLength(1); // single release carrying both tags
      expect(lc.anomalies).toEqual([]);
    });

    it('reconstructOne classifies a planning,tender release SET as tender in either tag order', () => {
      const both = (tag: string[]): Lifecycle =>
        reconstructOne([ev(oc('pt'), '000200-2026', tag)]);
      expect(both(['planning', 'tender']).state).toBe('tender');
      expect(both(['tender', 'planning']).state).toBe('tender');
    });
  });

  describe('§5.4 anomaly classes each fire with a stable reason', () => {
    it('out-of-order: 06e072 award→tenderUpdate records exactly one out-of-order anomaly', () => {
      const lc = lifecycleFor(oc('06e072'));
      expect(lc.state).toBe('awarded'); // a lower-stage update cannot pull the stage back
      expect(lc.anomalies).toHaveLength(1);
      expect(lc.anomalies[0]?.kind).toBe('anomaly');
      expect(lc.anomalies[0]?.reason).toBe('out-of-order');
      expect(lc.anomalies[0]?.releaseId).toBe('075924-2026');
    });

    it('contradiction: 05495a contractTermination→award→awardUpdate → terminated, two contradictions', () => {
      const lc = lifecycleFor(oc('05495a'));
      expect(lc.state).toBe('terminated'); // sticky terminal set first; later stages contradict it
      expect(lc.anomalies).toHaveLength(2);
      expect(lc.anomalies.map((a) => a.reason)).toEqual(['contradiction', 'contradiction']);
      expect(new Set(lc.anomalies.map((a) => a.releaseId))).toEqual(
        new Set(['076969-2026', '076972-2026']),
      );
    });

    it('duplicate: reconstructOne folds two events sharing a releaseId to one duplicate anomaly', () => {
      // The projection dedups upstream, so the pure machine is the only place a
      // duplicate can be observed — feed it directly (plan step 6).
      const dupId = '000123-2026';
      const lc = reconstructOne([ev(oc('dup'), dupId, ['tender']), ev(oc('dup'), dupId, ['tender'])]);
      expect(lc.state).toBe('tender'); // the single real fold still lands in tender
      expect(lc.amendmentCount).toBe(0);
      expect(lc.anomalies).toHaveLength(1);
      expect(lc.anomalies[0]?.kind).toBe('anomaly');
      expect(lc.anomalies[0]?.reason).toBe('duplicate');
      expect(lc.anomalies[0]?.releaseId).toBe(dupId);
    });

    it('the corpus anomaly set is exactly 5 events over 4 ocids, {out-of-order:3, contradiction:2}', () => {
      expect(summary.anomalyEvents).toBe(5);
      expect(summary.anomalousOcids).toBe(4);
      expect(flat).toHaveLength(5);
      // Flattened in ocid-ascending then notice-id order (a determinism property).
      expect(flat.map((a) => a['ocid'])).toEqual([
        oc('05495a'),
        oc('05495a'),
        oc('05faa0'),
        oc('06d2d1'),
        oc('06e072'),
      ]);
      const reasons = flat.map((a) => a['reason']);
      expect(reasons.filter((r) => r === 'out-of-order')).toHaveLength(3);
      expect(reasons.filter((r) => r === 'contradiction')).toHaveLength(2);
      expect(new Set(flat.map((a) => a['ocid']))).toEqual(
        new Set([oc('05495a'), oc('05faa0'), oc('06d2d1'), oc('06e072')]),
      );
      for (const a of flat) expect(a['kind']).toBe('anomaly');
    });

    it('the per-reason offending release ids are the pinned ones', () => {
      const ids = (reason: string): Set<string> =>
        new Set(flat.filter((a) => a['reason'] === reason).map((a) => a['releaseId'] as string));
      expect(ids('contradiction')).toEqual(new Set(['076969-2026', '076972-2026']));
      expect(ids('out-of-order')).toEqual(new Set(['076392-2026', '076902-2026', '075924-2026']));
    });
  });

  describe('orphan-base and skipped-stage are recorded as NORMAL, not anomalies', () => {
    it('059c19 orphan tenderUpdate → tender, orphanBase true, anomalies empty', () => {
      const lc = lifecycleFor(oc('059c19'));
      expect(lc.state).toBe('tender');
      expect(lc.orphanBase).toBe(true);
      expect(lc.amendmentCount).toBe(1);
      expect(lc.history).toHaveLength(1); // a single orphan release
      expect(lc.anomalies).toEqual([]); // window truncation is NOT dirty data
    });

    it('reports 125 orphan-base ocids and 2 skipped-stage ocids out of the anomaly channel', () => {
      expect(summary.orphanBaseOcids).toBe(125);
      expect(summary.skippedOcids).toBe(2);
    });

    it('headline anomalyRate is per-event (5/1624) — a low, meaningful health metric', () => {
      // Binding ruling m1: the headline rate is anomalyEvents/events, with
      // anomalousOcids reported alongside.
      expect(summary.anomalyRate).toBe(summary.anomalyEvents / summary.events);
      expect(summary.anomalyRate).toBeCloseTo(5 / 1624, 12);
      expect(summary.anomalyRate).toBeLessThan(0.01);
    });
  });

  describe('ORDER-INDEPENDENCE (§11) — permuting the event array cannot change the fold', () => {
    for (const [suffix, expectedState, expectedLen] of [
      ['06b607', 'tender', 3],
      ['05495a', 'terminated', 3],
      ['060882', 'awarded', 37],
    ] as const) {
      it(`reconstructOne(${suffix}) deep-equals for reverse and fixed rotations (${expectedLen} events)`, () => {
        const events = eventsForOcid(root, oc(suffix));
        expect(events).toHaveLength(expectedLen);

        const base = reconstructOne(events);
        expect(base.state).toBe(expectedState);
        expect(base.history).toEqual(sortEvents(events)); // the fold's only ordering is sortEvents

        for (const permutation of [
          reversed(events),
          rotated(events, 1),
          rotated(events, Math.floor(expectedLen / 2)),
        ]) {
          expect(reconstructOne(permutation)).toEqual(base);
        }
      });
    }

    it('sortEvents orders conforming release ids by numeric id then year', () => {
      const scrambled = [
        ev(oc('x'), '000100-2025', ['tender']),
        ev(oc('x'), '000010-2026', ['tender']),
        ev(oc('x'), '000010-2025', ['tender']),
        ev(oc('x'), '000002-2026', ['tender']),
      ];
      expect(sortEvents(scrambled).map((e) => e.releaseId)).toEqual([
        '000002-2026',
        '000010-2025',
        '000010-2026',
        '000100-2025',
      ]);
    });

    it('sortEvents is a permutation-invariant total order and does not throw on a malformed id', () => {
      const evs = [
        ev(oc('x'), '000010-2026', ['tender']),
        ev(oc('x'), 'not-an-id', ['tender']),
        ev(oc('x'), '000002-2026', ['tender']),
      ];
      let forward: LifecycleEvent[] | undefined;
      let backward: LifecycleEvent[] | undefined;
      expect(() => {
        forward = sortEvents(evs);
        backward = sortEvents([...evs].reverse());
      }).not.toThrow();
      expect(forward).toEqual(backward); // total order even with a non-conforming id present
    });

    it('reconstructMany groups by ocid and returns ocid-ascending regardless of input order', () => {
      const events = [
        ev('ocds-h6vhtk-zzz', '000002-2026', ['award', 'contract']),
        ev('ocds-h6vhtk-aaa', '000001-2026', ['tender']),
        ev('ocds-h6vhtk-zzz', '000001-2026', ['tender']),
        ev('ocds-h6vhtk-mmm', '000003-2026', ['planning']),
      ];
      const out = reconstructMany(events);
      expect(out.map((l) => l.ocid)).toEqual([
        'ocds-h6vhtk-aaa',
        'ocds-h6vhtk-mmm',
        'ocds-h6vhtk-zzz',
      ]);
      expect(out.find((l) => l.ocid === 'ocds-h6vhtk-zzz')?.state).toBe('awarded');
      expect(reconstructMany([...events].reverse())).toEqual(out); // input order irrelevant
    });
  });

  describe('the 37-notice framework tail does not blow up', () => {
    it('060882 folds 37 releases to awarded with empty anomalies', () => {
      const lc = lifecycleFor(oc('060882'));
      expect(lc.state).toBe('awarded');
      expect(lc.history).toHaveLength(37);
      expect(lc.anomalies).toEqual([]);
    });
  });

  describe('§5.3 determinism — a full rebuild re-derives byte-identical output', () => {
    it('re-running the projection yields byte-identical lifecycles and anomalies files', () => {
      const life1 = readBytesOrEmpty(lifecyclesPath(root));
      const anom1 = readBytesOrEmpty(anomaliesPath(root));
      projectLifecycles(root); // full rebuild over the same raw store
      const life2 = readBytesOrEmpty(lifecyclesPath(root));
      const anom2 = readBytesOrEmpty(anomaliesPath(root));
      expect(life2.equals(life1)).toBe(true);
      expect(anom2.equals(anom1)).toBe(true);
    });

    it('re-running the projection yields a deep-equal summary', () => {
      expect(projectLifecycles(root)).toEqual(summary);
    });

    it('reports an inspectable projection summary (executed-run numbers)', () => {
      // Captures the run's numbers in test output for the acceptance's
      // "state distribution and anomaly rate inspected and reported".
      // eslint-disable-next-line no-console
      console.log(
        `[lifecycle] ocids=${summary.ocids} events=${summary.events} ` +
          `awarded=${summary.stateDistribution.awarded} tender=${summary.stateDistribution.tender} ` +
          `pipeline=${summary.stateDistribution.pipeline} cancelled=${summary.stateDistribution.cancelled} ` +
          `terminated=${summary.stateDistribution.terminated} ` +
          `anomalyEvents=${summary.anomalyEvents} anomalousOcids=${summary.anomalousOcids} ` +
          `anomalyRate=${summary.anomalyRate} ` +
          `orphanBaseOcids=${summary.orphanBaseOcids} skippedOcids=${summary.skippedOcids}`,
      );
      expect(summary.ocids).toBe(1492);
      expect(readNdjson(lifecyclesPath(root))).toHaveLength(summary.ocids);
      expect(readNdjson(anomaliesPath(root))).toHaveLength(summary.anomalyEvents);
    });
  });
});
