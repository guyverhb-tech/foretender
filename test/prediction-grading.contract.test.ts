import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ingestWindow } from '../src/ingest/ingest.js';
import { createRawStore } from '../src/store/raw-store.js';
import { reconstructOne } from '../src/lifecycle/machine.js';
import type { LifecycleEvent, LifecycleState } from '../src/lifecycle/model.js';

// Modules under test (none exist until the builder implements this slice — these
// imports fail to resolve on a pre-build tree, which is the correct spec-first
// state; see .harness/test-plan.md §"Expected state").
import { ISO_WITH_OFFSET, requireOffsetIso, toEpochMs } from '../src/lifecycle/date.js';
import { predict } from '../src/prediction/predict.js';
import { projectPredictions } from '../src/prediction/project.js';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_PRIORS,
  PREDICTOR_VERSION,
} from '../src/prediction/model.js';
import type { Prediction } from '../src/prediction/model.js';
import { grade } from '../src/grading/grade.js';
import { calibrate } from '../src/grading/calibrate.js';
import { gradePredictions } from '../src/grading/project.js';
import { GRADER_VERSION, TENDER_ONSET_TAGS } from '../src/grading/model.js';
import type { PredictionRecord, Scoreboard, Verdict } from '../src/grading/model.js';

import {
  chainPages,
  loadBackfillDay,
  loadFixturePage,
  makeFixtureTransport,
  wholeStreamChain,
} from './helpers/fixture-transport.js';
import { makeVirtualClock, makeVirtualSleep, readNdjson } from './helpers/support.js';

/**
 * Prediction + grading contract (brief reqs 1–8; plan slice-5 steps 9–11) —
 * fixture-only, zero network. The pure units (predict / grade / calibrate /
 * requireOffsetIso) run on hand-built LifecycleEvent[] and hand-built verdicts
 * so the LOGIC is what's proven; the end-to-end block builds one temp store from
 * the committed corpus + the curated UK3 conversion chain and drives the two
 * offline projections through the injected fixture transport. setup.ts poisons
 * globalThis.fetch, so any accidental wire touch fails loudly.
 *
 * THE CRUX (brief §"No leakage"): the predictor's as-of set is chosen by a DATE
 * cutoff, never a release-id cutoff. The two axes disagree in confirmed FTS
 * inversions (a lower-id release dated later), so a real inversion pair is the
 * witness — an id cutoff would leak the post-cutoff tender and return null; the
 * date cutoff emits the honest pipeline prediction.
 *
 * All timestamps below carry an explicit offset (Z or ±HH:MM) — the B1 rule:
 * toEpochMs is Date.parse-based and therefore TZ-independent only for
 * offset-carrying strings; the bare 19-char local form is refused by
 * requireOffsetIso because its epoch would depend on the runner's TZ.
 *
 * Interface assumptions (see .harness/test-plan.md §Interface assumptions):
 *   predict(events: LifecycleEvent[], opts: {asof: string; ...}): Prediction | null
 *   grade(rec: PredictionRecord, events: LifecycleEvent[], opts: {asof: string}): Verdict
 *   calibrate(verdicts: Verdict[]): Scoreboard   // segments UK1,UK2,UK3,None + overall
 *   projectPredictions(root: string, opts: {asof: string}): PredictionSummary  // writes predictions.ndjson
 *   gradePredictions(root: string, opts: {asof: string}): Scoreboard           // writes verdicts.ndjson + scoreboard.json
 *   toEpochMs(iso: string | null): number | null   requireOffsetIso(iso, label): string
 */

// ── shared builders ────────────────────────────────────────────────────────

/** A hand-built lifecycle event (mirrors the slice-4 `ev` helper, plus fields). */
function mkEvent(
  ocid: string,
  releaseId: string,
  tag: string[],
  noticeType: string | null = null,
  date: string | null = null,
): LifecycleEvent {
  return { ocid, releaseId, tag, noticeType, date, regime: null };
}

/** Narrow a nullable to non-null with a failing message (keeps the assertion sharp). */
function notNull<T>(v: T | null, msg: string): T {
  if (v === null) throw new Error(msg);
  return v;
}

/** toEpochMs but throwing on null — for the ordering/relational assertions. */
function ms(iso: string): number {
  const e = toEpochMs(iso);
  if (e === null) throw new Error(`expected a parsable epoch for «${iso}»`);
  return e;
}

// The grader window shared by the synthetic verdict scenarios: madeAt D, ERD
// D + 38 days (the fixed horizon), both offset-carrying Z.
const GRADE_MADEAT = '2026-07-01T00:00:00.000Z';
const GRADE_ERD = '2026-08-08T00:00:00.000Z'; // D + 38d, verified: 2026-07-01 + 38 = 2026-08-08

function mkRecord(ocid: string, noticeType: string | null, p: number): PredictionRecord {
  return {
    ocid,
    noticeType,
    predictedProbability: p,
    expectedResolutionDate: GRADE_ERD,
    madeAt: GRADE_MADEAT,
  };
}

/** A structural Verdict for the calibrator arithmetic (calibrate never re-grades). */
function mkVerdict(
  ocid: string,
  noticeType: string | null,
  verdict: 'converted' | 'not_converted' | 'pending',
  predictedProbability: number,
): Verdict {
  const observedState: LifecycleState = verdict === 'converted' ? 'tender' : 'pipeline';
  return {
    kind: 'verdict',
    type: 'pipeline-to-tender',
    ocid,
    noticeType,
    verdict,
    predictedProbability,
    expectedResolutionDate: GRADE_ERD,
    madeAt: GRADE_MADEAT,
    conversionDate: verdict === 'converted' ? '2026-07-20T00:00:00.000Z' : null,
    observedState,
    gradedAt: '2026-09-01T00:00:00Z',
    graderVersion: GRADER_VERSION,
  };
}

const segKeys = ['UK1', 'UK2', 'UK3', 'None'] as const;
const statKeys = ['predictions', 'resolved', 'converted', 'not_converted', 'pending'] as const;

// ── B1: offset-aware epoch helper + --asof validator ───────────────────────

describe('requireOffsetIso + toEpochMs — offset-explicit, TZ-independent (B1, plan step 2)', () => {
  it('requireOffsetIso accepts a Z suffix and returns the string unchanged', () => {
    expect(requireOffsetIso('2026-09-01T00:00:00Z', '--asof')).toBe('2026-09-01T00:00:00Z');
  });

  it('requireOffsetIso accepts a positive and a negative numeric offset', () => {
    expect(requireOffsetIso('2026-09-01T00:00:00+01:00', '--asof')).toBe('2026-09-01T00:00:00+01:00');
    expect(requireOffsetIso('2026-09-01T00:00:00-05:00', '--asof')).toBe('2026-09-01T00:00:00-05:00');
  });

  it('requireOffsetIso THROWS on the bare 19-char local form, naming the argument', () => {
    // The exact epoch of a bare datetime is the runner's local-zone reading, so
    // §5.3 replay would differ across environments — it must be refused.
    expect(() => requireOffsetIso('2026-09-01T00:00:00', '--asof')).toThrow(/--asof/);
  });

  it('requireOffsetIso THROWS on a shape-valid but calendar-invalid datetime (S2-m1)', () => {
    // `2026-13-45T00:00:00Z` passes ISO_WITH_OFFSET but Date.parse → NaN, which
    // would otherwise degrade to a null epoch and silently grade everything
    // `pending` on the --asof/ERD boundary. It must fail loud, naming the arg.
    expect(() => requireOffsetIso('2026-13-45T00:00:00Z', '--asof')).toThrow(/--asof/);
    // The genuinely-valid offset forms are untouched — still returned unchanged.
    expect(requireOffsetIso('2026-09-01T00:00:00Z', '--asof')).toBe('2026-09-01T00:00:00Z');
    expect(requireOffsetIso('2026-09-01T00:00:00+01:00', '--asof')).toBe('2026-09-01T00:00:00+01:00');
  });

  it('ISO_WITH_OFFSET matches offset-carrying strings and rejects the bare form', () => {
    expect(ISO_WITH_OFFSET.test('2026-09-01T00:00:00Z')).toBe(true);
    expect(ISO_WITH_OFFSET.test('2026-09-01T00:00:00+01:00')).toBe(true);
    expect(ISO_WITH_OFFSET.test('2026-09-01T00:00:00')).toBe(false);
  });

  it('toEpochMs orders equal wall-times by offset (+00:00 is earlier than -01:00)', () => {
    expect(ms('2026-01-01T12:00:00+00:00')).toBeLessThan(ms('2026-01-01T12:00:00-01:00'));
  });

  it('toEpochMs(null) is null (a missing date never fabricates an epoch)', () => {
    expect(toEpochMs(null)).toBeNull();
  });
});

// ── The deterministic baseline predictor + the no-leakage date cutoff ───────

describe('predict — baseline prior + no-leakage DATE cutoff (brief reqs 1–2; the crux)', () => {
  const NOLEAK = 'ocds-h6vhtk-inv999';

  it('NO-LEAKAGE: on a real date-vs-id inversion, the date cutoff keeps the as-of set pipeline', () => {
    // Real committed inversion (backfill/2026-08-10/page-005): planning 075541
    // is dated EARLIER but has the HIGHER id; tender 075540 is dated LATER but
    // has the LOWER id. Assembled into one synthetic ocid.
    const events = [
      mkEvent(NOLEAK, '075541-2026', ['planning'], 'UK3', '2026-08-10T09:26:26+01:00'),
      mkEvent(NOLEAK, '075540-2026', ['tender'], null, '2026-08-10T09:26:27+01:00'),
    ];
    const p = notNull(
      predict(events, { asof: '2026-08-11T00:00:00Z' }),
      'expected a non-null pipeline prediction — the date cutoff must exclude the later-dated tender',
    );
    expect(p.type).toBe('pipeline-to-tender');
    expect(p.noticeType).toBe('UK3');
    expect(p.predictedProbability).toBe(0.165);
    expect(p.madeAt).toBe('2026-08-10T08:26:26.000Z'); // the planning date, in UTC
    expect(p.confidence).toBe(DEFAULT_CONFIDENCE);
    expect(p.predictorVersion).toBe(PREDICTOR_VERSION);

    // Both axes bite: the FULL truth (id-sorted fold over every event) is tender,
    // yet predict still emits pipeline — proving a DATE filter, not an id cutoff,
    // chose the as-of set. An id cutoff at 075541 would include the lower-id
    // 075540 (the tender) and force `predict` to return null.
    expect(reconstructOne(events).state).toBe('tender');
  });

  it('positive control: when date order agrees with id order it still emits pipeline', () => {
    const oc = 'ocds-h6vhtk-pos001';
    const events = [
      mkEvent(oc, '075540-2026', ['planning'], 'UK3', '2026-08-10T09:26:26+01:00'), // lower id, earlier
      mkEvent(oc, '075541-2026', ['tender'], null, '2026-08-10T09:26:27+01:00'), // higher id, later
    ];
    const p = notNull(predict(events, { asof: '2026-08-11T00:00:00Z' }), 'expected a pipeline prediction');
    expect(p.noticeType).toBe('UK3');
  });

  it('negative control: a tender dated at-or-before the cutoff makes the as-of set already tender → null', () => {
    const oc = 'ocds-h6vhtk-neg001';
    const events = [
      mkEvent(oc, '000002-2026', ['planning'], 'UK3', '2026-08-10T10:00:00+01:00'), // cutoff
      mkEvent(oc, '000001-2026', ['tender'], null, '2026-08-10T09:00:00+01:00'), // <= cutoff → in as-of
    ];
    expect(predict(events, { asof: '2026-08-11T00:00:00Z' })).toBeNull();
  });

  it('None = null noticeType → prediction carries null and the default prior 0.05', () => {
    const oc = 'ocds-h6vhtk-null01';
    const events = [mkEvent(oc, '000001-2026', ['planning'], null, '2026-08-01T00:00:00+01:00')];
    const p = notNull(predict(events, { asof: '2026-09-01T00:00:00Z' }), 'expected a pipeline prediction');
    expect(p.noticeType).toBeNull();
    expect(p.predictedProbability).toBe(0.05);
    // Horizon: ERD = madeAt + the configured horizon (brief req 2), relationally.
    expect(ms(p.expectedResolutionDate) - ms(p.madeAt)).toBe(DEFAULT_HORIZON_DAYS * 86_400_000);
  });

  it('None = unrecognised noticeType (m2): a UK99 code is PRESERVED in the record, priced at default', () => {
    const oc = 'ocds-h6vhtk-uk9901';
    const events = [mkEvent(oc, '000001-2026', ['planning'], 'UK99', '2026-08-01T00:00:00+01:00')];
    const p = notNull(predict(events, { asof: '2026-09-01T00:00:00Z' }), 'expected a pipeline prediction');
    expect(p.noticeType).toBe('UK99'); // surfaced verbatim, not coerced to null or dropped
    expect(p.predictedProbability).toBe(0.05); // default prior (unknown code)
  });

  it('cutoff/noticeType tie-break (m1): same-epoch events take the sortEvents-first noticeType, order-independent', () => {
    const oc = 'ocds-h6vhtk-tie001';
    const date = '2026-08-01T09:00:00+01:00';
    const lower = mkEvent(oc, '000010-2026', ['planning'], 'UK2', date); // lower id → sortEvents-first
    const higher = mkEvent(oc, '000020-2026', ['planning'], 'UK3', date); // higher id
    const forward = notNull(predict([lower, higher], { asof: '2026-09-01T00:00:00Z' }), 'expected a prediction');
    const reverse = notNull(predict([higher, lower], { asof: '2026-09-01T00:00:00Z' }), 'expected a prediction');
    expect(forward.noticeType).toBe('UK2');
    expect(reverse.noticeType).toBe('UK2'); // input array order is irrelevant
    expect(forward.predictedProbability).toBe(0.034); // the UK2 prior
  });

  it('cutoff/noticeType tie-break (m1): a null-dated earliest event does not perturb the cutoff', () => {
    const oc = 'ocds-h6vhtk-tie002';
    const events = [
      mkEvent(oc, '000001-2026', ['planning'], 'UK1', null), // earliest in the array, but null date
      mkEvent(oc, '000002-2026', ['planning'], 'UK3', '2026-08-01T09:00:00+01:00'), // supplies the cutoff
    ];
    const p = notNull(predict(events, { asof: '2026-09-01T00:00:00Z' }), 'expected a prediction');
    expect(p.noticeType).toBe('UK3'); // the dated event's noticeType, not the null-dated one's
    expect(p.predictedProbability).toBe(0.165);
  });

  it('cutoff-after-asof gate: a pipeline dated after --asof is not yet makeable → null', () => {
    const oc = 'ocds-h6vhtk-gate01';
    const events = [mkEvent(oc, '000001-2026', ['planning'], 'UK3', '2026-08-15T00:00:00+01:00')];
    expect(predict(events, { asof: '2026-08-11T00:00:00Z' })).toBeNull();
  });
});

// ── The deterministic grader: three verdicts + late-tender + cancellation ───

describe('grade — the three verdicts, independent of how the prediction was made (brief req 4)', () => {
  const ASOF_RESOLVED = '2026-09-01T00:00:00Z'; // >= ERD (Aug 8)
  const ASOF_EARLY = '2026-07-15T00:00:00Z'; // < ERD (Aug 8)

  it('converted: a tender dated within (madeAt, ERD] → converted, conversionDate = the onset', () => {
    const oc = 'ocds-h6vhtk-grd001';
    const events = [
      mkEvent(oc, '000001-2026', ['planning'], 'UK3', '2026-06-25T00:00:00+00:00'),
      mkEvent(oc, '000002-2026', ['tender'], null, '2026-07-20T00:00:00+00:00'),
    ];
    const v = grade(mkRecord(oc, 'UK3', 0.165), events, { asof: ASOF_RESOLVED });
    expect(v.verdict).toBe('converted');
    expect(v.conversionDate).toBe('2026-07-20T00:00:00.000Z');
    expect(v.graderVersion).toBe(GRADER_VERSION);
  });

  for (const tag of TENDER_ONSET_TAGS) {
    it(`converted: a '${tag}' onset within the window counts as a published-tender onset`, () => {
      const oc = `ocds-h6vhtk-onset-${tag}`;
      const events = [
        mkEvent(oc, '000001-2026', ['planning'], 'UK3', '2026-06-25T00:00:00+00:00'),
        mkEvent(oc, '000002-2026', [tag], null, '2026-07-20T00:00:00+00:00'),
      ];
      const v = grade(mkRecord(oc, 'UK3', 0.165), events, { asof: ASOF_RESOLVED });
      expect(v.verdict).toBe('converted');
    });
  }

  it('not_converted: no tender and --asof past the ERD → not_converted, conversionDate null', () => {
    const oc = 'ocds-h6vhtk-grd002';
    const events = [mkEvent(oc, '000001-2026', ['planning'], 'UK3', '2026-06-25T00:00:00+00:00')];
    const v = grade(mkRecord(oc, 'UK3', 0.165), events, { asof: ASOF_RESOLVED });
    expect(v.verdict).toBe('not_converted');
    expect(v.conversionDate).toBeNull();
  });

  it('pending: no tender and --asof before the ERD → pending (excluded from calibration)', () => {
    const oc = 'ocds-h6vhtk-grd003';
    const events = [mkEvent(oc, '000001-2026', ['planning'], 'UK3', '2026-06-25T00:00:00+00:00')];
    const v = grade(mkRecord(oc, 'UK3', 0.165), events, { asof: ASOF_EARLY });
    expect(v.verdict).toBe('pending');
  });

  it('late-tender: a tender dated AFTER the ERD, --asof past the ERD → not_converted', () => {
    const oc = 'ocds-h6vhtk-grd004';
    const events = [
      mkEvent(oc, '000001-2026', ['planning'], 'UK3', '2026-06-25T00:00:00+00:00'),
      mkEvent(oc, '000002-2026', ['tender'], null, '2026-08-20T00:00:00+00:00'), // > ERD (Aug 8)
    ];
    const v = grade(mkRecord(oc, 'UK3', 0.165), events, { asof: ASOF_RESOLVED });
    expect(v.verdict).toBe('not_converted'); // the deadline passed with no ON-TIME tender
    expect(v.conversionDate).toBe('2026-08-20T00:00:00.000Z'); // the onset is still recorded, just late
  });

  it('cancellation is not a tender onset (the 05250a shape): planningUpdate→tenderCancellation → not_converted', () => {
    const oc = 'ocds-h6vhtk-grd005';
    const events = [
      mkEvent(oc, '000001-2026', ['planningUpdate'], 'UK1', '2026-06-25T00:00:00+00:00'),
      mkEvent(oc, '000002-2026', ['tenderCancellation'], null, '2026-07-20T00:00:00+00:00'),
    ];
    const v = grade(mkRecord(oc, 'UK1', 0.067), events, { asof: ASOF_RESOLVED });
    expect(v.verdict).toBe('not_converted'); // a cancellation never evidences a published tender
    expect(v.conversionDate).toBeNull();
  });
});

// ── Calibration: Brier / hit-rate exact + segmentation ──────────────────────

describe('calibrate — Brier + hit-rate over resolved verdicts, segmented (brief req 5)', () => {
  it('EXACT Brier + hit-rate on a known UK3 set: 1 converted, 2 not_converted, 1 pending', () => {
    const verdicts = [
      mkVerdict('ocds-h6vhtk-c1', 'UK3', 'converted', 0.165),
      mkVerdict('ocds-h6vhtk-n1', 'UK3', 'not_converted', 0.165),
      mkVerdict('ocds-h6vhtk-n2', 'UK3', 'not_converted', 0.165),
      mkVerdict('ocds-h6vhtk-p1', 'UK3', 'pending', 0.165),
    ];
    const sb = calibrate(verdicts);
    const uk3 = sb.segments.UK3;
    expect(uk3.predictions).toBe(4);
    expect(uk3.resolved).toBe(3);
    expect(uk3.converted).toBe(1);
    expect(uk3.not_converted).toBe(2);
    expect(uk3.pending).toBe(1);
    expect(uk3.hitRate).toBeCloseTo(1 / 3, 12); // converted / resolved
    // brier = ((0.165-1)^2 + 2*(0.165^2)) / 3 = 0.751675 / 3
    expect(uk3.brier).toBeCloseTo(0.250_558_333_333_333_3, 10);
  });

  it('an empty segment yields resolved 0, hitRate 0, brier 0 (no divide-by-zero)', () => {
    const sb = calibrate([mkVerdict('ocds-h6vhtk-c1', 'UK3', 'converted', 0.165)]);
    expect(sb.segments.UK1).toEqual({
      predictions: 0,
      resolved: 0,
      converted: 0,
      not_converted: 0,
      pending: 0,
      hitRate: 0,
      brier: 0,
    });
  });

  it('an all-pending segment is resolved 0, hitRate 0, brier 0 (pending is excluded from calibration)', () => {
    const sb = calibrate([
      mkVerdict('ocds-h6vhtk-pp1', 'UK2', 'pending', 0.034),
      mkVerdict('ocds-h6vhtk-pp2', 'UK2', 'pending', 0.034),
    ]);
    expect(sb.segments.UK2).toEqual({
      predictions: 2,
      resolved: 0,
      converted: 0,
      not_converted: 0,
      pending: 2,
      hitRate: 0,
      brier: 0,
    });
  });

  it('segmentation (m2): UK1/UK2/UK3 land in their tracks; null AND UK99 fold into None; overall = the sums', () => {
    const verdicts = [
      mkVerdict('ocds-h6vhtk-a1', 'UK1', 'converted', 0.067),
      mkVerdict('ocds-h6vhtk-b1', 'UK2', 'not_converted', 0.034),
      mkVerdict('ocds-h6vhtk-c1', 'UK3', 'converted', 0.165),
      mkVerdict('ocds-h6vhtk-c2', 'UK3', 'pending', 0.165),
      mkVerdict('ocds-h6vhtk-d1', null, 'not_converted', 0.05), // None = null
      mkVerdict('ocds-h6vhtk-d2', 'UK99', 'converted', 0.05), // None = unrecognised (m2)
    ];
    const sb = calibrate(verdicts);
    expect(sb.segments.UK1.predictions).toBe(1);
    expect(sb.segments.UK2.predictions).toBe(1);
    expect(sb.segments.UK3.predictions).toBe(2);
    expect(sb.segments.None.predictions).toBe(2); // the null verdict AND the UK99 verdict
    expect(sb.segments.None.converted).toBe(1); // the UK99 conversion is counted, under None
    expect(sb.segments.None.not_converted).toBe(1); // the null not_converted

    // overall is exactly the sum of the four segments, key-by-key.
    for (const k of statKeys) {
      const segSum = segKeys.reduce((acc, seg) => acc + sb.segments[seg][k], 0);
      expect(sb.overall[k]).toBe(segSum);
    }
    expect(sb.overall.predictions).toBe(6);
    expect(sb.overall.converted).toBe(3); // UK1 + UK3 + UK99

    // Fixed segment order underpins scoreboard.json byte-determinism.
    expect(Object.keys(sb.segments)).toEqual(['UK1', 'UK2', 'UK3', 'None']);
  });
});

// ── End-to-end: real scoreboard over the committed corpus + conversion ──────

const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);
const WHOLE_STREAM_WINDOW = { updatedFrom: '2026-07-13T00:00:00', updatedTo: '2026-08-12T00:00:00' };
const DAY_WINDOWS: Record<string, { updatedFrom: string; updatedTo: string }> = {
  '2026-08-10': { updatedFrom: '2026-08-10T00:00:00', updatedTo: '2026-08-11T00:00:00' },
  '2026-08-11': { updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' },
  '2026-08-12': { updatedFrom: '2026-08-12T00:00:00', updatedTo: '2026-08-13T00:00:00' },
};
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'] as const;
/** The curated conversion chain's own single-day window (its `uri`'s window). */
const CONVERSION_WINDOW = { updatedFrom: '2026-07-22T00:00:00', updatedTo: '2026-07-23T00:00:00' };
const ASOF = '2026-09-01T00:00:00Z';
const CONVERSION_OCID = 'ocds-h6vhtk-069311';

const predictionsPath = (root: string): string => join(root, 'predictions.ndjson');
const verdictsPath = (root: string): string => join(root, 'verdicts.ndjson');
const scoreboardPath = (root: string): string => join(root, 'scoreboard.json');

/**
 * Build ONE temp store from the committed corpus (whole-stream chain + the three
 * backfill days, exactly as lifecycle.contract.test.ts:buildCorpusStore) PLUS the
 * curated UK3 conversion chain — all on one shared virtual clock through the
 * injected fixture transport. The conversion page lives under conversions/ and is
 * invisible to slice-4's hardcoded wholeStreamChain list.
 */
async function buildFullStore(root: string): Promise<void> {
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
  {
    const page = loadFixturePage('conversions', 'uk3-069311');
    const chain = chainPages([page]);
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...CONVERSION_WINDOW });
  }
}

describe('scoreboard over the committed corpus + UK3 conversion (§11 acceptance, §5.3, B1)', () => {
  let root: string;
  let scoreboard: Scoreboard;
  let predictions: Array<Record<string, unknown>>;
  let verdicts: Array<Record<string, unknown>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-scoreboard-'));
    await buildFullStore(root);
    projectPredictions(root, { asof: ASOF });
    scoreboard = gradePredictions(root, { asof: ASOF });
    predictions = readNdjson(predictionsPath(root));
    verdicts = readNdjson(verdictsPath(root));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves ≥1 REAL prediction against its real subsequent tender (brief req 8 — the acceptance)', () => {
    const v = verdicts.find((r) => r['ocid'] === CONVERSION_OCID);
    expect(v).toBeDefined();
    expect(v?.['verdict']).toBe('converted');
    expect(v?.['noticeType']).toBe('UK3');
    // The real subsequent tender 069310, dated 2026-07-22T15:56:54+01:00 → UTC.
    expect(v?.['conversionDate']).toBe('2026-07-22T14:56:54.000Z');
    expect(v?.['predictedProbability']).toBe(0.165);
    expect(v?.['madeAt']).toBe('2026-07-22T14:27:49.000Z'); // the real planning date, in UTC
    expect(v?.['expectedResolutionDate']).toBe('2026-08-29T14:27:49.000Z'); // madeAt + 38d
    expect(scoreboard.segments.UK3.converted).toBeGreaterThanOrEqual(1);
  });

  it('is structurally complete: one verdict per prediction, consistent segments, overall = sums', () => {
    const predOcids = predictions.map((r) => r['ocid']);
    const verdOcids = verdicts.map((r) => r['ocid']);
    expect(new Set(verdOcids).size).toBe(verdicts.length); // exactly one verdict row per ocid
    expect(verdicts.length).toBe(predictions.length); // one verdict per prediction
    expect(new Set(verdOcids)).toEqual(new Set(predOcids)); // same ocid set

    expect(Object.keys(scoreboard.segments)).toEqual(['UK1', 'UK2', 'UK3', 'None']);
    for (const seg of segKeys) {
      const s = scoreboard.segments[seg];
      expect(s.converted + s.not_converted).toBe(s.resolved);
      expect(s.resolved + s.pending).toBe(s.predictions);
    }
    const o = scoreboard.overall;
    expect(o.converted + o.not_converted).toBe(o.resolved);
    expect(o.resolved + o.pending).toBe(o.predictions);
    for (const k of statKeys) {
      const segSum = segKeys.reduce((acc, seg) => acc + scoreboard.segments[seg][k], 0);
      expect(o[k]).toBe(segSum);
    }
    expect(o.predictions).toBe(predictions.length);
    expect(o.converted).toBeGreaterThanOrEqual(1); // guaranteed by the 069311 witness
  });

  it('reports the per-segment scoreboard (the acceptance\'s "reported" evidence)', () => {
    // The three-verdict LOGIC is proven exhaustively on the synthetic sets above;
    // brief req 8 mandates only ≥1 REAL resolved. Real not_converted/pending
    // counts at this --asof are LOGGED, not hard-asserted (Risks row 7 hedge):
    // whether a class is non-empty depends on the committed dates and the horizon.
    const classCounts = { converted: 0, not_converted: 0, pending: 0 };
    for (const v of verdicts) {
      const key = v['verdict'] as 'converted' | 'not_converted' | 'pending';
      classCounts[key] += 1;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[scoreboard] asof=${ASOF} predictions=${scoreboard.overall.predictions} ` +
        `verdictClasses=${JSON.stringify(classCounts)} ` +
        `overall={resolved:${scoreboard.overall.resolved},hitRate:${scoreboard.overall.hitRate},brier:${scoreboard.overall.brier}} ` +
        `UK1=${JSON.stringify(scoreboard.segments.UK1)} UK2=${JSON.stringify(scoreboard.segments.UK2)} ` +
        `UK3=${JSON.stringify(scoreboard.segments.UK3)} None=${JSON.stringify(scoreboard.segments.None)}`,
    );
    expect(classCounts.converted).toBeGreaterThanOrEqual(1);
    expect(classCounts.converted + classCounts.not_converted + classCounts.pending).toBe(verdicts.length);
  });

  it('§5.3 determinism: a second full rebuild is byte-identical across all three outputs', () => {
    const p1 = readFileSync(predictionsPath(root));
    const v1 = readFileSync(verdictsPath(root));
    const s1 = readFileSync(scoreboardPath(root));
    projectPredictions(root, { asof: ASOF });
    const sb2 = gradePredictions(root, { asof: ASOF });
    expect(readFileSync(predictionsPath(root)).equals(p1)).toBe(true);
    expect(readFileSync(verdictsPath(root)).equals(v1)).toBe(true);
    expect(readFileSync(scoreboardPath(root)).equals(s1)).toBe(true);
    expect(sb2).toEqual(scoreboard); // gradedAt derives from --asof, not wall-clock
  });

  it('TZ-independence (B1): output is byte-identical under TZ=UTC vs America/Los_Angeles', async () => {
    const original = process.env.TZ;
    const rootA = await mkdtemp(join(tmpdir(), 'foretender-tzA-'));
    const rootB = await mkdtemp(join(tmpdir(), 'foretender-tzB-'));
    try {
      await buildFullStore(rootA);
      await buildFullStore(rootB);

      // Self-verifying probe (round-2 hardening, decisions.md): a BARE parse MUST
      // differ under the two zones — if the environment ever stops honouring
      // per-op process.env.TZ, this fails loud instead of the byte-identity check
      // false-greening on two no-op runs.
      process.env.TZ = 'UTC';
      const bareUtc = Date.parse('2026-09-01T00:00:00');
      process.env.TZ = 'America/Los_Angeles';
      const bareLa = Date.parse('2026-09-01T00:00:00');
      expect(bareUtc).not.toBe(bareLa);

      process.env.TZ = 'UTC';
      projectPredictions(rootA, { asof: ASOF });
      gradePredictions(rootA, { asof: ASOF });

      process.env.TZ = 'America/Los_Angeles';
      projectPredictions(rootB, { asof: ASOF });
      gradePredictions(rootB, { asof: ASOF });

      for (const rel of ['predictions.ndjson', 'verdicts.ndjson', 'scoreboard.json']) {
        expect(readFileSync(join(rootB, rel)).equals(readFileSync(join(rootA, rel)))).toBe(true);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });
});

// ── Fail loud on a shape-drifted predictions ledger (I-m1 ⊕ S-m1) ────────────

describe('gradePredictions — a malformed predictions-ledger row fails LOUD (I-m1 ⊕ S-m1)', () => {
  it('THROWS on a shape-drifted row instead of silently NaN-ing or dropping to pending', async () => {
    // The grader reads predictions.ndjson by field NAME (§5.1), so a corrupt or
    // key-renamed row has no compile-time guard. Coercing it silently would poison
    // the Brier fold (non-finite probability → NaN) or drop every verdict to
    // pending (offset-less ERD → null epoch). Both must THROW, naming the field.
    const root = await mkdtemp(join(tmpdir(), 'foretender-badledger-'));
    try {
      const wellFormed = {
        ocid: CONVERSION_OCID,
        noticeType: 'UK3',
        predictedProbability: 0.165,
        expectedResolutionDate: GRADE_ERD,
        madeAt: GRADE_MADEAT,
      };
      const writeLedger = (rec: Record<string, unknown>): void =>
        writeFileSync(predictionsPath(root), `${JSON.stringify(rec)}\n`);

      // A non-numeric predictedProbability would coerce to NaN and poison Brier.
      writeLedger({ ...wellFormed, predictedProbability: 'oops' });
      expect(() => gradePredictions(root, { asof: ASOF })).toThrow(/predictedProbability/);

      // A bare (offset-less) expectedResolutionDate would parse to a null epoch and
      // silently drop every verdict to pending — reuse the B1 offset guard.
      writeLedger({ ...wellFormed, expectedResolutionDate: '2026-08-08T00:00:00' });
      expect(() => gradePredictions(root, { asof: ASOF })).toThrow(/expectedResolutionDate/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
