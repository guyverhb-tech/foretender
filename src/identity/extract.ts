/**
 * The pure per-ocid identity resolver (slice 6). No I/O, no clock, no throw:
 * given the raw releases of ONE procurement (any tag — planning/tender/award),
 * `extractIdentity` returns its `Identity`.
 *
 * Each field is resolved INDEPENDENTLY from the LATEST release that provides a
 * non-null value: the releases are ordered by the slice-4 total order on release
 * id (`compareReleaseId`, higher id = later/version order) and walked
 * newest-first per field, the first non-null winning. Because that order is
 * TOTAL (numeric id, then year, then the full id), "latest" is unambiguous even
 * on a numeric-id tie — the documented stable tie-break.
 *
 * Scalars are coerced with the slice-3 primitives so a hostile non-scalar value
 * is nulled at RELEASE granularity rather than aborting the whole-store
 * projection (mirrors `event.ts`/`normalise.ts`): `safeStr` for the string
 * fields (title/buyer), `num`/`str` for `value`. Title reads `tender.title`,
 * falling back to the planning-family title where a release carries no tender
 * title; buyer reads `buyer.name`, falling back to the first `parties[]` entry
 * whose `roles` include "buyer".
 */
import { compareReleaseId } from '../lifecycle/machine.js';
import { safeStr } from '../normalise/normalise.js';
import type { Identity } from './model.js';

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** `tender.title`, else the planning-family title; scalar-coerced via `safeStr`. */
function titleOf(rel: Obj): string | null {
  const tender = isObject(rel['tender']) ? rel['tender'] : undefined;
  const fromTender = tender !== undefined ? safeStr(tender['title']) : null;
  if (fromTender !== null) return fromTender;
  const planning = isObject(rel['planning']) ? rel['planning'] : undefined;
  return planning !== undefined ? safeStr(planning['title']) : null;
}

/** `buyer.name`, else the first `parties[]` entry whose `roles` include "buyer". */
function buyerOf(rel: Obj): string | null {
  const buyer = isObject(rel['buyer']) ? rel['buyer'] : undefined;
  const fromBuyer = buyer !== undefined ? safeStr(buyer['name']) : null;
  if (fromBuyer !== null) return fromBuyer;
  for (const party of array(rel['parties'])) {
    if (!isObject(party)) continue;
    if (array(party['roles']).includes('buyer')) {
      const name = safeStr(party['name']);
      if (name !== null) return name;
    }
  }
  return null;
}

/** The `tender.value` block, or an empty object — the slice-3 value paths. */
function valueOf(rel: Obj): Obj {
  const tender = isObject(rel['tender']) ? rel['tender'] : {};
  return isObject(tender['value']) ? tender['value'] : {};
}

const grossOf = (rel: Obj): number | null => num(valueOf(rel)['amountGross']);
const netOf = (rel: Obj): number | null => num(valueOf(rel)['amount']);
const currencyOf = (rel: Obj): string | null => str(valueOf(rel)['currency']);

interface RankedRelease {
  releaseId: string;
  body: Obj;
}

/**
 * Resolve one procurement's identity from its releases (in any input order).
 * `ocid` is the caller's grouping key; the identity carries it verbatim so the
 * record's ocid always matches the store's accepted-release identity.
 */
export function extractIdentity(ocid: string, releases: readonly unknown[]): Identity {
  const ranked: RankedRelease[] = releases.map((raw) => {
    const body = isObject(raw) ? raw : {};
    return { releaseId: safeStr(body['id']) ?? '', body };
  });
  // Ascending by the slice-4 total order → the last element is the latest.
  ranked.sort((a, b) => compareReleaseId(a.releaseId, b.releaseId));

  /** The newest release yielding a non-null value for `read`, and which one it was. */
  const latest = <T>(
    read: (rel: Obj) => T | null,
  ): { value: T | null; releaseId: string | null } => {
    for (let i = ranked.length - 1; i >= 0; i--) {
      const rel = ranked[i];
      if (rel === undefined) continue;
      const value = read(rel.body);
      if (value !== null) return { value, releaseId: rel.releaseId };
    }
    return { value: null, releaseId: null };
  };

  const title = latest(titleOf);
  return {
    ocid,
    title: title.value,
    buyer: latest(buyerOf).value,
    value: {
      gross: latest(grossOf).value,
      net: latest(netOf).value,
      currency: latest(currencyOf).value,
    },
    sourceReleaseId: title.releaseId,
  };
}
