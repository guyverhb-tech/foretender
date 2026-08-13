/**
 * The pure tender normaliser (brief reqs 1–3; invariants #9–#13; plan step 2).
 * No I/O, no network, no clock: same input → same output. It branches on
 * `tender.legalBasis.scheme` and reads each regime's OBSERVED Phase-0 paths into
 * one canonical shape, or returns a `TenderAnomaly` with a stable reason for a
 * genuine shape violation.
 *
 * Determinism (§5.3): values and dates are copied VERBATIM — numbers as numbers,
 * ISO datetimes as strings — with no `Date` parsing and no arithmetic, and a
 * missing nullable is `null`, never coerced to 0/"" (invariant #10). Gross and
 * net are kept distinct and never mixed.
 */
import type {
  AnomalyReason,
  CanonicalCpv,
  CanonicalLot,
  NormaliseResult,
  Regime,
  TenderAnomaly,
} from './model.js';

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function makeAnomaly(
  releaseId: string,
  ocid: string | null,
  regime: string | null,
  reason: AnomalyReason,
  detail?: string,
): TenderAnomaly {
  return {
    kind: 'anomaly',
    releaseId,
    ocid,
    regime,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Coerce a raw value to a canonical string, or `null` for a non-scalar value.
 * Only safe scalar types (`string`/`number`/`bigint`) are stringified: a hostile
 * deeply nested array (or any object) would make `String(value)` throw a
 * `RangeError` (S-m1 for a CPV `id`; S-m3 for `legalBasis.scheme`), which uncaught
 * would abort the whole-store projection. Every caller keeps the result nullable,
 * so one pathological value is nulled at RELEASE granularity rather than killing
 * the run — the release still fails loud at the intended point (an empty CPV list
 * fires `missing-cpv`; a non-scalar scheme falls to the `unknown-regime` anomaly).
 */
export function safeStr(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

/** Map a raw classification object to a canonical CPV entry (verbatim id/description). */
function toCpv(c: Obj): CanonicalCpv {
  // Both callers filter `c.scheme === 'CPV'` before calling, so scheme is 'CPV'.
  return {
    scheme: 'CPV',
    id: safeStr(c['id']),
    description: str(c['description']),
  };
}

/** CPV via `tender.items[].additionalClassifications[]` (the UKPGA path; invariant #11). */
function cpvFromItems(tender: Obj): CanonicalCpv[] {
  const out: CanonicalCpv[] = [];
  for (const item of array(tender['items'])) {
    if (!isObject(item)) continue;
    for (const c of array(item['additionalClassifications'])) {
      if (isObject(c) && c['scheme'] === 'CPV') out.push(toCpv(c));
    }
  }
  return out;
}

/** CPV via `tender.classification` (CELEX-only; a single object or an array). */
function cpvFromClassification(tender: Obj): CanonicalCpv[] {
  const tc = tender['classification'];
  const out: CanonicalCpv[] = [];
  if (Array.isArray(tc)) {
    for (const c of tc) if (isObject(c) && c['scheme'] === 'CPV') out.push(toCpv(c));
  } else if (isObject(tc) && tc['scheme'] === 'CPV') {
    out.push(toCpv(tc));
  }
  return out;
}

/** The first `documents[].noticeType` present (UKPGA notice-type discriminator). */
function firstNoticeType(tender: Obj): string | null {
  for (const doc of array(tender['documents'])) {
    if (isObject(doc)) {
      const nt = str(doc['noticeType']);
      if (nt !== null) return nt;
    }
  }
  return null;
}

/** Map every lot uniformly for both regimes; every sub-field nullable (m1). */
function mapLots(tender: Obj): CanonicalLot[] {
  return array(tender['lots']).map((raw): CanonicalLot => {
    const lot = isObject(raw) ? raw : {};
    const cp = isObject(lot['contractPeriod']) ? lot['contractPeriod'] : {};
    const renewal = isObject(lot['renewal']) ? lot['renewal'] : {};
    return {
      id: str(lot['id']),
      contractPeriod: {
        startDate: str(cp['startDate']),
        endDate: str(cp['endDate']),
        durationInDays: num(cp['durationInDays']),
        maxExtentDate: str(cp['maxExtentDate']),
      },
      hasRenewal: bool(lot['hasRenewal']),
      renewalDescription: str(renewal['description']),
    };
  });
}

const tagsOf = (release: Obj): string[] =>
  array(release['tag']).filter((t): t is string => typeof t === 'string');

export function normaliseTender(release: unknown): NormaliseResult {
  const rel = isObject(release) ? release : {};
  const releaseId = str(rel['id']) ?? '';
  const ocid = str(rel['ocid']);

  const tender = rel['tender'];
  if (!isObject(tender)) {
    return makeAnomaly(releaseId, ocid, null, 'missing-tender-block');
  }

  const legalBasis = tender['legalBasis'];
  const scheme = isObject(legalBasis) ? legalBasis['scheme'] : undefined;
  if (scheme === undefined || scheme === null) {
    return makeAnomaly(releaseId, ocid, null, 'missing-legal-basis-scheme');
  }
  let regime: Regime;
  if (scheme === 'UKPGA' || scheme === 'CELEX') {
    regime = scheme;
  } else {
    // Route through the shared scalar-only coercion: a non-scalar (e.g. hostile
    // deeply nested) scheme is nulled instead of hitting a raw `String()` that
    // would throw a `RangeError` and abort the whole-store projection (S-m3).
    // The release still fails loud here as an `unknown-regime` anomaly.
    const bad = safeStr(scheme);
    return makeAnomaly(releaseId, ocid, bad, 'unknown-regime', bad ?? undefined);
  }

  const mpc = str(tender['mainProcurementCategory']);
  if (mpc === null) {
    return makeAnomaly(releaseId, ocid, regime, 'missing-main-procurement-category');
  }

  const value = isObject(tender['value']) ? tender['value'] : {};
  const currency = str(value['currency']);

  let noticeType: string | null;
  let cpv: CanonicalCpv[];
  let gross: number | null;
  let deadline: string | null;
  let deadlineSource: 'tenderPeriod' | 'expressionOfInterest' | null;

  const tenderPeriod = isObject(tender['tenderPeriod']) ? tender['tenderPeriod'] : {};
  const tenderPeriodEnd = str(tenderPeriod['endDate']);

  if (regime === 'UKPGA') {
    // Estimated value is the UK-extension gross field; core `amount` is net.
    gross = num(value['amountGross']);
    cpv = cpvFromItems(tender);
    // Deadline splits across two fields by procedure type (invariant #13).
    if (tenderPeriodEnd !== null) {
      deadline = tenderPeriodEnd;
      deadlineSource = 'tenderPeriod';
    } else {
      const eoi = str(tender['expressionOfInterestDeadline']);
      deadline = eoi;
      deadlineSource = eoi !== null ? 'expressionOfInterest' : null;
    }
    noticeType = firstNoticeType(tender);
    if (noticeType !== 'UK4' && noticeType !== 'UK13') {
      return makeAnomaly(releaseId, ocid, regime, 'unknown-notice-type', noticeType ?? undefined);
    }
  } else {
    // CELEX: no gross; CPV is the union of the top-level classification and any
    // item additionalClassifications; deadline is tenderPeriod only.
    gross = null;
    cpv = [...cpvFromClassification(tender), ...cpvFromItems(tender)];
    deadline = tenderPeriodEnd;
    deadlineSource = tenderPeriodEnd !== null ? 'tenderPeriod' : null;
    noticeType = null;
  }

  if (cpv.length === 0) {
    return makeAnomaly(releaseId, ocid, regime, 'missing-cpv');
  }

  return {
    kind: 'canonical',
    ocid: ocid ?? '',
    releaseId,
    tags: tagsOf(rel),
    regime,
    noticeType,
    value: { gross, net: num(value['amount']), currency },
    cpv,
    mainProcurementCategory: mpc,
    deadline,
    deadlineSource,
    lots: mapLots(tender),
  };
}
