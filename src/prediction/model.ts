/**
 * The prediction model and baseline constants (brief reqs 1–2; plan slice-5
 * step 1). Type-only + constants module, mirroring `lifecycle/model.ts`: it
 * fixes the ledger contract the pure predictor (`predict.ts`), the projection
 * (`project.ts`), and the contract tests bind to.
 *
 * A `Prediction` is a falsifiable, per-ocid record stated in advance: the
 * predictor sees only events dated at or before its own cutoff (the no-leakage
 * DATE cutoff), stamps `madeAt`/`predictorVersion`, and never touches a
 * wall-clock. `noticeType` carries the RAW value the release supplied — null or
 * even an unexpected string — never coerced; the calibration segment is derived
 * from it separately (see `lifecycle/segment.ts`).
 */
// The calibration segment (`UK1`/`UK2`/`UK3`/`None`) a prediction folds into
// lives downward in `lifecycle/segment.ts`, so the prediction and grading layers
// share one definition without importing each other (§5.1). Imported here for
// the `PredictionSummary.bySegment` map below; consumers import it direct.
import type { Segment } from '../lifecycle/segment.js';

/** A per-noticeType base rate plus a floor for null/unknown codes. */
export interface PriorMap {
  UK1: number;
  UK2: number;
  UK3: number;
  default: number;
}

/** A falsifiable, per-ocid pipeline-to-tender prediction (canonical key order). */
export interface Prediction {
  kind: 'prediction';
  type: 'pipeline-to-tender';
  ocid: string;
  /** The RAW noticeType at the cutoff event — null or an unexpected string, never coerced. */
  noticeType: string | null;
  predictedProbability: number;
  expectedResolutionDate: string;
  confidence: number;
  madeAt: string;
  predictorVersion: string;
}

/** The projection's inspectable roll-up (per-segment `None` = null-or-unrecognised). */
export interface PredictionSummary {
  predictions: number;
  bySegment: Record<Segment, number>;
}

/** Predictor knobs; every field but `asof` defaults to the exported constant. */
export interface PredictOpts {
  /** MUST carry an explicit offset (validated at the projection/CLI boundary). */
  asof: string;
  priors?: PriorMap;
  horizonDays?: number;
  confidence?: number;
  version?: string;
}

/**
 * The fixed population base rates (the leakage guard — set once, NEVER
 * recomputed from the graded data). In-window pipeline→tender floors per
 * noticeType from pipeline-volume.md §3; `default` 0.05 ≈ the pooled 44/918
 * floor for a null/unknown noticeType.
 */
export const DEFAULT_PRIORS: PriorMap = { UK1: 0.067, UK2: 0.034, UK3: 0.165, default: 0.05 };

/** The legacy median planning→tender lag (pipeline-volume.md:82), in days. */
export const DEFAULT_HORIZON_DAYS = 38;

/** A single fixed confidence — the graded number is calibration, not confidence (brief req 5). */
export const DEFAULT_CONFIDENCE = 0.5;

/** Stamped on every prediction so the ledger replays bit-identically. */
export const PREDICTOR_VERSION = 'pipeline-to-tender-baseline@1';
