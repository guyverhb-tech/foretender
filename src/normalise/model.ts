/**
 * The canonical tender model and anomaly types (brief reqs 1–3; invariants
 * #9–#13; plan step 1). Type-only module: it fixes the output contract that the
 * pure core (`normalise.ts`), the projection (`project.ts`), and the contract
 * tests all bind to.
 *
 * Two regimes normalise into ONE shape. A field the Phase-0 census shows below
 * 100% for a regime (`amountGross` on CELEX, dates on UK13 dynamic-market
 * notices) is NULLABLE — its absence is a valid regime difference, not a shape
 * violation. Only a genuine shape violation (census-100%-per-regime field
 * missing, unknown scheme/notice-type) becomes a `TenderAnomaly`.
 *
 * Deliberately NO tender-level `contractPeriod`: it never occurs in the corpus
 * (package-shape sharp-edge 9); contract dates are lot-level only.
 */

export type Regime = 'UKPGA' | 'CELEX';

/**
 * A single CPV classification, read verbatim (no arithmetic, no re-derivation).
 * `id` is nullable: a non-scalar raw id (e.g. a hostile deeply nested array) is
 * nulled rather than coerced via `String()`, which could throw (S-m1).
 */
export interface CanonicalCpv {
  scheme: string;
  id: string | null;
  description: string | null;
}

/**
 * A lot's contract period. All four sub-fields are read uniformly from the raw
 * lot for BOTH regimes, nulling those absent — UKPGA characteristically carries
 * `startDate`/`endDate`/`maxExtentDate`, CELEX characteristically `durationInDays`
 * (plus a minority `startDate`/`endDate`), but the reader does not assume that
 * (m1: the CELEX `endDate` branch is load-bearing for the pinned `lotEndDate`).
 */
export interface CanonicalContractPeriod {
  startDate: string | null;
  endDate: string | null;
  durationInDays: number | null;
  maxExtentDate: string | null;
}

/**
 * One lot. `hasRenewal` is stored faithfully as `boolean | null`: on UKPGA the
 * boolean appears only when true (so `null` is "not asked", not "false"); on
 * CELEX it appears as both true and false (package-shape sharp-edge 4). No
 * interpretation is baked in.
 */
export interface CanonicalLot {
  id: string | null;
  contractPeriod: CanonicalContractPeriod;
  hasRenewal: boolean | null;
  renewalDescription: string | null;
}

/** Which field the submission deadline was read from (grading defers the modelling call). */
export type DeadlineSource = 'tenderPeriod' | 'expressionOfInterest';

export interface CanonicalTender {
  kind: 'canonical';
  ocid: string;
  releaseId: string;
  tags: string[];
  regime: Regime;
  /** UKPGA: first `documents[].noticeType` (∈ {UK4,UK13}); CELEX: null (no notice type). */
  noticeType: string | null;
  /** Gross (VAT-inclusive, UKPGA-only) and net (core `amount`) kept distinct, never mixed. */
  value: {
    gross: number | null;
    net: number | null;
    currency: string | null;
  };
  cpv: CanonicalCpv[];
  mainProcurementCategory: string | null;
  deadline: string | null;
  deadlineSource: DeadlineSource | null;
  lots: CanonicalLot[];
}

/**
 * A genuine shape violation, recorded with a stable `reason` instead of a
 * silently-coerced record (brief §5.4; invariant #7). The projection counts
 * these as an observable health metric.
 */
export type AnomalyReason =
  | 'missing-tender-block'
  | 'missing-legal-basis-scheme'
  | 'unknown-regime'
  | 'missing-main-procurement-category'
  | 'missing-cpv'
  | 'unknown-notice-type';

export interface TenderAnomaly {
  kind: 'anomaly';
  releaseId: string;
  ocid: string | null;
  /** The recognised regime when known; the raw scheme string for `unknown-regime`; null otherwise. */
  regime: string | null;
  reason: AnomalyReason;
  /** The offending value (bad scheme, bad notice type) when one is available. */
  detail?: string;
}

export type NormaliseResult = CanonicalTender | TenderAnomaly;
