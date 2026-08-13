/**
 * The pure lifecycle-event extractor (brief reqs 1, 7; plan step 2). No I/O, no
 * clock, no throw: `toLifecycleEvent` reads one raw release of ANY type into the
 * lightweight `LifecycleEvent` the state machine consumes.
 *
 * It reuses the one slice-3 primitive that fits — `safeStr` (exported additively
 * from `normalise.ts`) — for RangeError-safe scalar coercion of `id`/`ocid`/
 * `date`/`scheme`/`noticeType`; a hostile non-scalar is nulled at release
 * granularity rather than aborting a whole-store projection.
 *
 * `noticeType` is read family-aware (planning/tender/award documents live at
 * different paths) and CARRIED on the event for a later prediction slice, but is
 * never used to decide state — state is tag-driven (invariant #7/#14). A null
 * `noticeType` or `regime` is therefore normal, not an anomaly.
 */
import { safeStr } from '../normalise/normalise.js';
import type { LifecycleEvent } from './model.js';

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The event's tags, string members only (mirrors `tagsOf` in `normalise.ts`). */
const tagsOf = (rel: Obj): string[] =>
  array(rel['tag']).filter((t): t is string => typeof t === 'string');

/** Map `tender.legalBasis.scheme` to a known regime, or `null` (never an anomaly here). */
function regimeOf(tender: unknown): LifecycleEvent['regime'] {
  if (!isObject(tender)) return null;
  const legalBasis = tender['legalBasis'];
  const scheme = isObject(legalBasis) ? legalBasis['scheme'] : undefined;
  if (scheme === 'UKPGA' || scheme === 'CELEX') return scheme;
  return null;
}

/** The first `documents[].noticeType` present on a container object, coerced via `safeStr`. */
function firstDocNoticeType(container: unknown): string | null {
  if (!isObject(container)) return null;
  for (const doc of array(container['documents'])) {
    if (isObject(doc)) {
      const nt = safeStr(doc['noticeType']);
      if (nt !== null) return nt;
    }
  }
  return null;
}

/** The award family nests documents one level deeper: `contracts[].documents[]`. */
function firstContractNoticeType(rel: Obj): string | null {
  for (const contract of array(rel['contracts'])) {
    const nt = firstDocNoticeType(contract);
    if (nt !== null) return nt;
  }
  return null;
}

const PLANNING_TAGS = new Set(['planning', 'planningUpdate']);
const TENDER_TAGS = new Set(['tender', 'tenderUpdate', 'tenderCancellation']);

/** Read `noticeType` from the family-specific path the tags select (first match wins). */
function noticeTypeFor(rel: Obj, tags: string[]): string | null {
  if (tags.some((t) => PLANNING_TAGS.has(t))) return firstDocNoticeType(rel['planning']);
  if (tags.some((t) => TENDER_TAGS.has(t))) return firstDocNoticeType(rel['tender']);
  return firstContractNoticeType(rel);
}

export function toLifecycleEvent(release: unknown): LifecycleEvent {
  const rel = isObject(release) ? release : {};
  const tag = tagsOf(rel);
  return {
    ocid: safeStr(rel['ocid']) ?? '',
    releaseId: safeStr(rel['id']) ?? '',
    tag,
    noticeType: noticeTypeFor(rel, tag),
    date: safeStr(rel['date']),
    regime: regimeOf(rel['tender']),
  };
}
