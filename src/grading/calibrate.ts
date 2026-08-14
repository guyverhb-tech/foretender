/**
 * The calibrator (brief req 5; invariant #17; plan slice-5 step 7). Pure: a fold
 * over resolved (non-pending) verdicts, segmented `UK1/UK2/UK3/None`. Per segment:
 * counts + `hitRate` (converted/resolved) + `brier` (mean of
 * `(predictedProbability − outcome)²` over resolved, outcome 1=converted
 * 0=not_converted); plus an `overall` block across all verdicts.
 *
 * The fold walks verdicts in ocid-sorted order and emits segments in fixed
 * `UK1,UK2,UK3,None` order, so the float sums — and therefore `scoreboard.json` —
 * are byte-reproducible.
 */
import { segmentOf } from '../lifecycle/segment.js';
import type { Segment } from '../lifecycle/segment.js';
import { GRADER_VERSION } from './model.js';
import type { Scoreboard, SegmentStats, Verdict } from './model.js';

const SEGMENTS: readonly Segment[] = ['UK1', 'UK2', 'UK3', 'None'];

const emptyStats = (): SegmentStats => ({
  predictions: 0,
  resolved: 0,
  converted: 0,
  not_converted: 0,
  pending: 0,
  hitRate: 0,
  brier: 0,
});

export function calibrate(verdicts: Verdict[]): Scoreboard {
  const sorted = [...verdicts].sort((a, b) => (a.ocid < b.ocid ? -1 : a.ocid > b.ocid ? 1 : 0));

  const segments: Record<Segment, SegmentStats> = {
    UK1: emptyStats(),
    UK2: emptyStats(),
    UK3: emptyStats(),
    None: emptyStats(),
  };
  const overall = emptyStats();
  const brierSum: Record<Segment | 'overall', number> = {
    UK1: 0,
    UK2: 0,
    UK3: 0,
    None: 0,
    overall: 0,
  };

  for (const v of sorted) {
    const seg = segmentOf(v.noticeType);
    for (const bucket of [segments[seg], overall]) {
      bucket.predictions += 1;
      if (v.verdict === 'pending') {
        bucket.pending += 1;
        continue;
      }
      bucket.resolved += 1;
      if (v.verdict === 'converted') bucket.converted += 1;
      else bucket.not_converted += 1;
    }
    if (v.verdict !== 'pending') {
      const outcome = v.verdict === 'converted' ? 1 : 0;
      const d = v.predictedProbability - outcome;
      brierSum[seg] += d * d;
      brierSum.overall += d * d;
    }
  }

  for (const seg of SEGMENTS) finalize(segments[seg], brierSum[seg]);
  finalize(overall, brierSum.overall);

  const first = sorted[0];
  return {
    gradedAt: first?.gradedAt ?? '',
    graderVersion: first?.graderVersion ?? GRADER_VERSION,
    segments,
    overall,
  };
}

/** Divide the accumulated sums into rates; a resolved-0 segment is 0/0 → 0, no NaN. */
function finalize(s: SegmentStats, brierSum: number): void {
  s.hitRate = s.resolved === 0 ? 0 : s.converted / s.resolved;
  s.brier = s.resolved === 0 ? 0 : brierSum / s.resolved;
}
