/**
 * The deterministic three-verdict grader (brief req 4; plan slice-5 step 6).
 * Pure: no I/O, no clock. It reconstructs the ocid's full history via the
 * lifecycle machine (for the canonical sorted/deduped events + an `observedState`
 * context field) but owns its OWN conversion definition (`TENDER_ONSET_TAGS`), so
 * it neither imports the predictor (§5.1) nor infers from the machine's fragile
 * `skippedStages`/terminal flags.
 *
 * A tender-onset is the earliest OBSERVED (date ≤ now) event whose tag intersects
 * `TENDER_ONSET_TAGS`. Then: converted iff an onset is dated ≤ ERD; else
 * not_converted iff the deadline has passed (now ≥ ERD) with no on-time onset —
 * which also catches a LATE tender dated after the ERD; else pending.
 */
import { reconstructOne } from '../lifecycle/machine.js';
import { toEpochMs } from '../lifecycle/date.js';
import type { LifecycleEvent } from '../lifecycle/model.js';
import { GRADER_VERSION, TENDER_ONSET_TAGS } from './model.js';
import type { PredictionRecord, Verdict, VerdictOutcome } from './model.js';

const ONSET_TAGS = new Set(TENDER_ONSET_TAGS);

export function grade(
  prediction: PredictionRecord,
  events: LifecycleEvent[],
  opts: { asof: string; version?: string },
): Verdict {
  const lc = reconstructOne(events);
  // Preconditions (enforced at the projection/CLI boundary): opts.asof and the
  // prediction's ERD both carry an explicit offset, so their epochs are non-null.
  const nowMs = toEpochMs(opts.asof);
  const erdMs = toEpochMs(prediction.expectedResolutionDate);

  let firstOnset: number | null = null;
  for (const ev of lc.history) {
    const ms = toEpochMs(ev.date);
    if (ms === null || (nowMs !== null && ms > nowMs)) continue; // unobservable / in the future
    if (!ev.tag.some((t) => ONSET_TAGS.has(t))) continue;
    if (firstOnset === null || ms < firstOnset) firstOnset = ms;
  }

  let verdict: VerdictOutcome;
  if (firstOnset !== null && erdMs !== null && firstOnset <= erdMs) {
    verdict = 'converted';
  } else if (nowMs !== null && erdMs !== null && nowMs >= erdMs) {
    verdict = 'not_converted';
  } else {
    verdict = 'pending';
  }

  return {
    kind: 'verdict',
    type: 'pipeline-to-tender',
    ocid: prediction.ocid,
    noticeType: prediction.noticeType,
    verdict,
    predictedProbability: prediction.predictedProbability,
    expectedResolutionDate: prediction.expectedResolutionDate,
    madeAt: prediction.madeAt,
    // The onset is recorded whenever one exists — even a LATE one that graded not_converted.
    conversionDate: firstOnset !== null ? new Date(firstOnset).toISOString() : null,
    observedState: lc.state,
    gradedAt: opts.asof,
    graderVersion: opts.version ?? GRADER_VERSION,
  };
}
