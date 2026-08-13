/**
 * The lifecycle model and anomaly types (brief reqs 1–2; invariants #6–#8, #14;
 * plan step 1). Type-only module mirroring `normalise/model.ts`: it fixes the
 * output contract that the pure extractor (`event.ts`), the state machine
 * (`machine.ts`), the projection (`project.ts`), and the contract tests bind to.
 *
 * A `LifecycleEvent` is deliberately lightweight and family-agnostic — one shape
 * for every release type (planning/tender/award/terminal), carrying only what the
 * state machine needs plus a non-state-driving `noticeType` reserved for a later
 * prediction slice. State is TAG-driven (invariant #7/#14), so `noticeType` never
 * decides a transition and a null `noticeType`/`regime` is normal, not an anomaly.
 */

/** The monotonic high-water stage a procurement has reached. */
export type LifecycleStage = 'pipeline' | 'tender' | 'awarded';

/** A derived current state: the stage, unless a sticky terminal overrides it. */
export type LifecycleState = LifecycleStage | 'cancelled' | 'terminated' | 'unknown';

/**
 * A genuine mis-ordering within an OBSERVED sequence (never window truncation).
 * Orphan first-releases and skipped stages are recorded as NORMAL attributes on
 * `Lifecycle`, not as anomalies (plan Approach; §5.4).
 */
export type LifecycleAnomalyReason = 'out-of-order' | 'contradiction' | 'duplicate';

/** A lightweight canonical event extracted from one raw release of ANY type. */
export interface LifecycleEvent {
  ocid: string;
  releaseId: string;
  tag: string[];
  /** Carried for a future prediction slice; never used to decide state. */
  noticeType: string | null;
  date: string | null;
  regime: 'UKPGA' | 'CELEX' | null;
}

/** A recorded departure from the clean path, mirroring `TenderAnomaly`'s shape. */
export interface LifecycleAnomaly {
  kind: 'anomaly';
  ocid: string;
  reason: LifecycleAnomalyReason;
  releaseId: string;
  /** The offending transition when one is available (e.g. "award after terminated"). */
  detail?: string;
}

/** One procurement reconstructed from its ordered event history. */
export interface Lifecycle {
  ocid: string;
  state: LifecycleState;
  regime: 'UKPGA' | 'CELEX' | null;
  history: LifecycleEvent[];
  amendmentCount: number;
  /** First observed release is an update/amend whose base predates the window (NORMAL). */
  orphanBase: boolean;
  /** A stage was skipped over (e.g. cancellation before tender) (NORMAL). */
  skippedStages: boolean;
  anomalies: LifecycleAnomaly[];
}

/** The projection's inspectable roll-up over one raw store. */
export interface LifecycleSummary {
  ocids: number;
  events: number;
  stateDistribution: Record<LifecycleState, number>;
  anomalyEvents: number;
  anomalousOcids: number;
  /** Headline rate is per-EVENT (`anomalyEvents / events`); ruling m1. */
  anomalyRate: number;
  orphanBaseOcids: number;
  skippedOcids: number;
  regime: { UKPGA: number; CELEX: number };
}
