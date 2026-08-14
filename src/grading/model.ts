/**
 * The grading model and grader constants (brief reqs 4–5; plan slice-5 step 5).
 * Type-only + constants module. It fixes the verdict/scoreboard contract the pure
 * grader (`grade.ts`), the calibrator (`calibrate.ts`), the projection
 * (`project.ts`), and the contract tests bind to.
 *
 * §5.1 boundary: this module does NOT import `src/prediction`. The grader reads a
 * STRUCTURAL `PredictionRecord` — the ledger subset it consumes — so it cannot
 * know how a prediction was made; the `predictions.ndjson` file is the only
 * coupling between the two layers.
 */
import type { LifecycleState } from '../lifecycle/model.js';

/** The ledger subset the grader consumes — a structural read, not the predictor's `Prediction`. */
export interface PredictionRecord {
  ocid: string;
  noticeType: string | null;
  predictedProbability: number;
  expectedResolutionDate: string;
  madeAt: string;
}

/** The three graded outcomes; `pending` is excluded from calibration. */
export type VerdictOutcome = 'converted' | 'not_converted' | 'pending';

/** One graded prediction (canonical key order). */
export interface Verdict {
  kind: 'verdict';
  type: 'pipeline-to-tender';
  ocid: string;
  noticeType: string | null;
  verdict: VerdictOutcome;
  predictedProbability: number;
  expectedResolutionDate: string;
  madeAt: string;
  conversionDate: string | null;
  observedState: LifecycleState;
  gradedAt: string;
  graderVersion: string;
}

/** Per-segment (and overall) calibration counts + scores. */
export interface SegmentStats {
  predictions: number;
  resolved: number;
  converted: number;
  not_converted: number;
  pending: number;
  hitRate: number;
  brier: number;
}

/** The segmented scoreboard (segments in fixed `UK1,UK2,UK3,None` order). */
export interface Scoreboard {
  gradedAt: string;
  graderVersion: string;
  segments: { UK1: SegmentStats; UK2: SegmentStats; UK3: SegmentStats; None: SegmentStats };
  overall: SegmentStats;
}

/** Stamped on every verdict so the ledger replays bit-identically. */
export const GRADER_VERSION = 'pipeline-to-tender-grader@1';

/**
 * The grader's OWN conversion criterion (§5.1) — the tags that evidence a
 * published tender-or-later notice. `tenderUpdate` counts as onset because an
 * update implies the tender was published. This is the grader's own definition,
 * NOT the machine's stage model; `planning`/`planningUpdate` (still pipeline) and
 * `tenderCancellation`/`contractTermination` (terminals that do not evidence a
 * published tender) are deliberately excluded — that is why `05250a` grades
 * not_converted.
 */
export const TENDER_ONSET_TAGS: readonly string[] = ['tender', 'tenderUpdate', 'award', 'contract'];
