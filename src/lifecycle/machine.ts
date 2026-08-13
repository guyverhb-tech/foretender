/**
 * The pure lifecycle state machine (brief req 2; invariants #6–#8, #14; plan
 * step 3). ZERO I/O, ZERO clock: the reconstruction is a deterministic function
 * of the events alone.
 *
 * Order-independence (§11) is bought by "sort canonically, then fold". Every
 * ordering used anywhere in this module is `sortEvents` — a TOTAL order on
 * `releaseId` (numeric-id-before-dash, then the year, then the full id as the
 * unique tiebreak). Because release ids are unique, ANY input permutation
 * collapses to the identical sorted sequence, so the left fold yields bit-
 * identical output. `reconstructMany` returns its groups ocid-ascending, never in
 * Map-insertion order, so grouping is order-independent too.
 *
 * State is derived from the TAG, never the (optional, ~37%-null) noticeType. The
 * fold classifies each event, maintains a monotonic high-water stage plus a
 * sticky terminal, and records an anomaly ONLY for a genuine mis-ordering within
 * the observed sequence — orphan first-releases and skipped stages are NORMAL
 * attributes (window truncation), not anomalies.
 */
import type {
  Lifecycle,
  LifecycleAnomaly,
  LifecycleAnomalyReason,
  LifecycleEvent,
  LifecycleState,
} from './model.js';

/** Release ids are `NNNNNN-YYYY`; a non-conforming id sorts last, by full string. */
const RELEASE_ID = /^(\d+)-(\d+)$/;

/**
 * The numeric sort key of a release id. A non-conforming id keys to
 * (+Infinity, +Infinity) so it sorts after every conforming id while the
 * full-string tiebreak keeps the order total — no crash, no NaN (the `!==`
 * guards below never subtract two infinities).
 */
function idKey(id: string): [number, number] {
  const m = RELEASE_ID.exec(id);
  if (m === null) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  return [Number(m[1]), Number(m[2])];
}

/** Total order on `releaseId`: numeric id, then year, then the (unique) full id. */
export function sortEvents(events: LifecycleEvent[]): LifecycleEvent[] {
  return [...events].sort((a, b) => {
    const [na, ya] = idKey(a.releaseId);
    const [nb, yb] = idKey(b.releaseId);
    if (na !== nb) return na - nb;
    if (ya !== yb) return ya - yb;
    return a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0;
  });
}

type Kind = 'stage' | 'amend' | 'terminal';
type Rank = 0 | 1 | 2 | 3;

interface Classification {
  kind: Kind;
  rank: Rank;
  terminal?: 'cancelled' | 'terminated';
  /** The minimum stage a terminal expects to have reached; a shortfall is a skipped stage. */
  required?: Rank;
}

/** A RULES row: a tag and how it classifies. `tag` doubles as the human label. */
type Rule = { tag: string } & Classification;

/**
 * Tag → classification (plan step 3). A terminal is sticky and requires a minimum
 * stage; a `*Update`/`implementation` is an amend that modifies without advancing;
 * a base tag is a stage. Terminals are listed FIRST because they take absolute
 * precedence in `classify`; the stage/amend rows are ordered by ascending rank. An
 * unrecognised tag is rank-0 `unknown` (kept only for totality — none occur on the
 * corpus).
 */
const RULES: ReadonlyArray<Rule> = [
  { tag: 'contractTermination', kind: 'terminal', rank: 3, terminal: 'terminated', required: 3 },
  { tag: 'tenderCancellation', kind: 'terminal', rank: 2, terminal: 'cancelled', required: 2 },
  { tag: 'planningUpdate', kind: 'amend', rank: 1 },
  { tag: 'planning', kind: 'stage', rank: 1 },
  { tag: 'tenderUpdate', kind: 'amend', rank: 2 },
  { tag: 'tender', kind: 'stage', rank: 2 },
  { tag: 'awardUpdate', kind: 'amend', rank: 3 },
  { tag: 'contractUpdate', kind: 'amend', rank: 3 },
  { tag: 'contractAmendment', kind: 'amend', rank: 3 },
  { tag: 'award', kind: 'stage', rank: 3 },
  { tag: 'contract', kind: 'stage', rank: 3 },
  { tag: 'implementation', kind: 'amend', rank: 3 },
];

/**
 * Classify a release from its tag SET.
 *
 * A terminal tag decides the classification outright and BEFORE any stage/amend
 * tag is considered — `contractTermination` outranks `tenderCancellation` (they
 * are listed terminal-first). This terminal precedence is what keeps the sticky
 * `cancelled`/`terminated` states and their counts stable.
 *
 * A NON-terminal release is classified by the HIGHEST rank over the stage/amend
 * tags it carries — the monotonic high-water model (see the module header), NOT
 * the first-listed tag: a combined `planning,tender` release is a `tender`
 * (rank 2), not `planning` (rank 1). At EQUAL rank a `stage` tag outranks its
 * `amend` variant (e.g. `tender` beats `tenderUpdate`) — the release has reached
 * the stage it names — so `classify` stays a TOTAL function even on a same-rank
 * stage+amend set (no such set occurs on the corpus; the tie-break is specified
 * for totality, not because a fixture needs it).
 */
function classify(tags: string[]): Rule {
  for (const rule of RULES) {
    if (rule.kind === 'terminal' && tags.includes(rule.tag)) return rule;
  }
  let best: Rule | null = null;
  for (const rule of RULES) {
    if (rule.kind === 'terminal' || !tags.includes(rule.tag)) continue;
    const outranks = best === null || rule.rank > best.rank;
    const stageWinsTie =
      best !== null && rule.rank === best.rank && rule.kind === 'stage' && best.kind === 'amend';
    if (outranks || stageWinsTie) best = rule;
  }
  return best ?? { tag: 'unknown', kind: 'stage', rank: 0 };
}

const STATE_BY_STAGE = ['unknown', 'pipeline', 'tender', 'awarded'] as const;
const stageName = (stage: Rank): LifecycleState => STATE_BY_STAGE[stage] ?? 'unknown';

/**
 * Reconstruct one procurement's lifecycle from its events, in ANY input order.
 * Permutation-invariance holds under `releaseId` UNIQUENESS: two events sharing a
 * `releaseId` are treated as duplicates (the second is skipped and recorded as a
 * `duplicate` anomaly), so if same-`releaseId` events differed in content the
 * surviving fold would depend on arrival order. `projectLifecycles` guarantees the
 * precondition — it dedups by `releaseId` upstream — so this is a documented
 * precondition of the direct export, not a live hazard through the projection.
 */
export function reconstructOne(events: LifecycleEvent[]): Lifecycle {
  const sorted = sortEvents(events);

  let stage: Rank = 0;
  let terminal: 'cancelled' | 'terminated' | null = null;
  let amendmentCount = 0;
  let orphanBase = false;
  let skippedStages = false;
  const seenIds = new Set<string>();
  const anomalies: LifecycleAnomaly[] = [];

  const ocid = sorted[0]?.ocid ?? '';
  const record = (reason: LifecycleAnomalyReason, ev: LifecycleEvent, detail?: string): void => {
    anomalies.push({
      kind: 'anomaly',
      ocid: ev.ocid,
      reason,
      releaseId: ev.releaseId,
      ...(detail !== undefined ? { detail } : {}),
    });
  };

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev === undefined) continue;
    const cls = classify(ev.tag);

    // (a) a release id already folded → duplicate, skip (the projection dedups
    // upstream, so this only fires when the machine is fed a duplicate directly).
    if (seenIds.has(ev.releaseId)) {
      record('duplicate', ev);
      continue;
    }
    seenIds.add(ev.releaseId);

    // (b) a terminal is already set → any further event contradicts it; advance
    // the stage high-water for the record but keep the sticky terminal.
    if (terminal !== null) {
      record('contradiction', ev, `${cls.tag} after ${terminal}`);
      stage = Math.max(stage, cls.rank) as Rank;
      continue;
    }

    // (c) this event is itself terminal → set the sticky terminal. A stage-0
    // first release is an orphan (base predates the window, NORMAL); a shortfall
    // below the terminal's required stage is a skipped stage (NORMAL). No anomaly.
    if (cls.kind === 'terminal') {
      if (stage === 0) orphanBase = true;
      else if (cls.required !== undefined && stage < cls.required) skippedStages = true;
      terminal = cls.terminal ?? null;
      continue;
    }

    // (d) a lower-stage event after a higher stage → out-of-order; the stage does
    // not regress.
    if (cls.rank < stage) {
      record('out-of-order', ev, `${cls.tag} after stage ${stageName(stage)}`);
      continue;
    }

    // (e) clean advance/amend.
    if (i === 0 && cls.kind === 'amend') orphanBase = true; // first release is an update
    if (stage !== 0 && cls.rank > stage + 1) skippedStages = true; // jumped a stage
    stage = Math.max(stage, cls.rank) as Rank;
    if (cls.kind === 'amend') amendmentCount++;
  }

  const state: LifecycleState = terminal ?? stageName(stage);
  const regime = sorted.find((e) => e.regime !== null)?.regime ?? null;

  return {
    ocid,
    state,
    regime,
    history: sorted,
    amendmentCount,
    orphanBase,
    skippedStages,
    anomalies,
  };
}

/** Group events by ocid, reconstruct each, and return the lifecycles ocid-ascending. */
export function reconstructMany(events: LifecycleEvent[]): Lifecycle[] {
  const groups = new Map<string, LifecycleEvent[]>();
  for (const ev of events) {
    let group = groups.get(ev.ocid);
    if (group === undefined) {
      group = [];
      groups.set(ev.ocid, group);
    }
    group.push(ev);
  }
  return [...groups.keys()].sort().map((ocid) => reconstructOne(groups.get(ocid) ?? []));
}
