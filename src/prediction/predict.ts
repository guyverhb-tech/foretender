/**
 * The deterministic baseline predictor + the no-leakage DATE cutoff (brief req 2;
 * plan slice-5 step 3). Pure: no I/O, no clock. Emits a `Prediction` only when
 * the as-of, date-filtered reconstruction is still `pipeline`.
 *
 * THE CRUX (§"No leakage"): `reconstructOne` sorts by numeric release id, but the
 * cutoff is TEMPORAL, and the two axes disagree in confirmed FTS inversions (a
 * lower-id release dated later). So the as-of set is chosen by an offset-aware
 * epoch cutoff applied BEFORE `reconstructOne`, never by a release-id cutoff —
 * `sortEvents` is used only to break a same-epoch noticeType tie, never to
 * include or exclude an event from the as-of set.
 */
import { reconstructOne, sortEvents } from '../lifecycle/machine.js';
import { toEpochMs } from '../lifecycle/date.js';
import type { LifecycleEvent } from '../lifecycle/model.js';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_PRIORS,
  PREDICTOR_VERSION,
} from './model.js';
import type { PredictOpts, Prediction, PriorMap } from './model.js';

const MS_PER_DAY = 86_400_000;
const PLANNING_FAMILY = new Set(['planning', 'planningUpdate']);

/** The base rate for a noticeType — an EXACT match only; anything else is `default`. */
function priorFor(noticeType: string | null, priors: PriorMap): number {
  if (noticeType === 'UK1') return priors.UK1;
  if (noticeType === 'UK2') return priors.UK2;
  if (noticeType === 'UK3') return priors.UK3;
  return priors.default;
}

export function predict(events: LifecycleEvent[], opts: PredictOpts): Prediction | null {
  const priors = opts.priors ?? DEFAULT_PRIORS;
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const confidence = opts.confidence ?? DEFAULT_CONFIDENCE;
  const version = opts.version ?? PREDICTOR_VERSION;

  // Planning-family events with a parsable date set the cutoff. A null-dated
  // planning event cannot supply a cutoff and never perturbs it.
  const planning = events.filter(
    (e) => e.tag.some((t) => PLANNING_FAMILY.has(t)) && toEpochMs(e.date) !== null,
  );
  if (planning.length === 0) return null;

  let cutoff = Number.POSITIVE_INFINITY;
  for (const e of planning) {
    const ms = toEpochMs(e.date);
    if (ms !== null && ms < cutoff) cutoff = ms;
  }

  // Not yet makeable as of `now` (opts.asof is a validated offset-carrying string).
  const asofMs = toEpochMs(opts.asof);
  if (asofMs === null || cutoff > asofMs) return null;

  // The as-of set is strictly DATE-filtered — never id-cut — so a later-dated,
  // lower-id release cannot leak in past the cutoff.
  const asOf = events.filter((e) => {
    const ms = toEpochMs(e.date);
    return ms !== null && ms <= cutoff;
  });
  if (reconstructOne(asOf).state !== 'pipeline') return null;

  // noticeType is the value at the cutoff epoch: the sortEvents-first (releaseId-
  // ordered) planning event whose epoch equals the cutoff — a total tie-break.
  const cutoffEvent = sortEvents(planning.filter((e) => toEpochMs(e.date) === cutoff))[0];
  const noticeType = cutoffEvent?.noticeType ?? null;

  return {
    kind: 'prediction',
    type: 'pipeline-to-tender',
    ocid: cutoffEvent?.ocid ?? '',
    noticeType,
    predictedProbability: priorFor(noticeType, priors),
    expectedResolutionDate: new Date(cutoff + horizonDays * MS_PER_DAY).toISOString(),
    confidence,
    madeAt: new Date(cutoff).toISOString(),
    predictorVersion: version,
  };
}
