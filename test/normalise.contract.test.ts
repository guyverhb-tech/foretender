import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestWindow } from '../src/ingest/ingest.js';
import {
  createRawStore,
  readAcceptedReleases,
  readPageBody,
} from '../src/store/raw-store.js';
import { normaliseTender } from '../src/normalise/normalise.js';
import { projectTenders, type ProjectionSummary } from '../src/normalise/project.js';
import type {
  CanonicalTender,
  NormaliseResult,
  TenderAnomaly,
} from '../src/normalise/model.js';
import {
  loadBackfillDay,
  makeFixtureTransport,
  wholeStreamChain,
  type RecordedExchange,
} from './helpers/fixture-transport.js';
import {
  makeVirtualClock,
  makeVirtualSleep,
  pagesDir,
  readNdjson,
  readReleases,
  sha256Hex,
} from './helpers/support.js';

/**
 * Tender-normalisation contract (brief reqs 1–7; invariants #9–#13; plan
 * steps 7–10) — fixture-only, zero network (no transport touches the wire; the
 * store is built through the injected fixture transport and the setup.ts fetch
 * poison is the backstop).
 *
 * THE TWO HARD CONDITIONS, and how the teeth are built:
 *
 *  Condition 1 (field-presence RATES matched to the Phase-0 census, NOT "parses
 *  without error"). Two independent oracles bracket every count:
 *    (a) a test-side STRUCTURAL reader (`rawTenderOracle`) reads the raw fixture
 *        bodies directly — it never calls the normaliser — and its per-field
 *        counts are pinned to hard integer literals cross-referenced to the
 *        census. This catches fixture drift and pins the census.
 *    (b) the normaliser's own `fieldCoverage` summary is asserted EQUAL to the
 *        independent oracle, field by field. A wrong path in the normaliser
 *        makes canonical coverage DISAGREE with the raw read (demonstrated in
 *        .harness/test-plan.md: re-pointing `amountGross` at a wrong path drops
 *        the normaliser's count to 0 while the raw oracle still reads 200, so
 *        the equality assertion fails). For the census-100% REQUIRED fields
 *        (cpv, mainProcurementCategory, CELEX tenderPeriodEnd) coverage-over-
 *        canonical is tautological; there the disagreement instead surfaces as
 *        an anomaly spike + a population/id-set mismatch, and the four
 *        independent ZERO-guards catch a decoy path.
 *
 *  Condition 2 (fail loud on unmapped shapes; anomaly rate is an OBSERVABLE
 *  count + rate). The clean 230-release corpus yields 0/230 anomalies; six
 *  labelled-synthetic unmapped inputs each return an anomaly with its reason
 *  (never a coerced canonical record); and a seeded store surfaces a non-zero
 *  count + rate in `anomalies.ndjson`.
 *
 * Authoritative fixture population (orchestrator-verified, recomputed from disk
 * by the test-author — see .harness/test-plan.md): 204 UKPGA + 26 CELEX = 230
 * unique tender-tagged releases over whole-stream (5 pages) + the three
 * backfill/ days. plan.md is authoritative for these counts, NOT scout.md.
 *
 * Interface assumptions (see .harness/test-plan.md §Interface assumptions):
 *   normaliseTender(release: unknown): NormaliseResult   // CanonicalTender | TenderAnomaly
 *   projectTenders(rootDir: string): ProjectionSummary   // synchronous full rebuild
 *   readAcceptedReleases(rootDir): AcceptedRelease[]
 *   readPageBody(rootDir, bodyHash): Uint8Array          // hash-validated
 *   store siblings <root>/canonical.ndjson, <root>/anomalies.ndjson
 */

type Json = Record<string, any>;

const BASE = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);

/** The whole-stream chain's window is page-001's own `uri` window. */
const WHOLE_STREAM_WINDOW = {
  updatedFrom: '2026-07-13T00:00:00',
  updatedTo: '2026-08-12T00:00:00',
};
/** Each committed backfill day walks a one-London-day window. */
const DAY_WINDOWS: Record<string, { updatedFrom: string; updatedTo: string }> = {
  '2026-08-10': { updatedFrom: '2026-08-10T00:00:00', updatedTo: '2026-08-11T00:00:00' },
  '2026-08-11': { updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' },
  '2026-08-12': { updatedFrom: '2026-08-12T00:00:00', updatedTo: '2026-08-13T00:00:00' },
};
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'] as const;

const canonicalPath = (root: string): string => join(root, 'canonical.ndjson');
const anomaliesPath = (root: string): string => join(root, 'anomalies.ndjson');
const readBytesOrEmpty = (p: string): Buffer => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));

/**
 * Build ONE temp store from the committed fixtures the way the existing
 * contract tests do: ingest the whole-stream chain, then each backfill day, on
 * one shared virtual clock (cross-run pacing is real but instantaneous under
 * virtual sleep). Dedupe is the store's own frozen-snapshot dedupe on release
 * `id`; byte-identical cross-corpus collisions make the result order-stable.
 */
async function buildCorpusStore(root: string): Promise<void> {
  const clock = makeVirtualClock(T0);
  const { sleep } = makeVirtualSleep(clock);

  {
    const chain = wholeStreamChain();
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...WHOLE_STREAM_WINDOW });
  }
  for (const day of DAYS) {
    const chain = loadBackfillDay(day);
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    const window = DAY_WINDOWS[day];
    if (window === undefined) throw new Error(`no window for day ${day}`);
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...window });
  }
}

// --- Independent structural reader over the RAW fixture bodies (Condition 1a) ---
// It is deliberately NOT the normaliser: it traverses OCDS paths directly, so a
// wrong path in the normaliser produces a canonical-vs-raw DISAGREEMENT.

interface OraclePopulation {
  ukpga: Json[];
  celex: Json[];
  other: Json[];
  /** tender-tagged releases that ALSO carry the `planning` tag (dual). */
  dualTender: Json[];
  /** every accepted release id, whatever its tag (for exclusion checks). */
  allAcceptedIds: Set<string>;
}

/** Drive the oracle off the store's accepted-release projection so its
 *  population is EXACTLY the projection's (both read `releases.ndjson`), then
 *  filter tender-tagged and split by scheme with independent path reads. */
function rawTenderOracle(root: string): OraclePopulation {
  const accepted = readReleases(root);
  const cache = new Map<string, Json>();
  const pop: OraclePopulation = {
    ukpga: [],
    celex: [],
    other: [],
    dualTender: [],
    allAcceptedIds: new Set<string>(),
  };
  for (const rec of accepted) {
    const id = rec['id'] as string;
    const bodyHash = rec['bodyHash'] as string;
    pop.allAcceptedIds.add(id);
    let pkg = cache.get(bodyHash);
    if (pkg === undefined) {
      pkg = JSON.parse(readFileSync(join(pagesDir(root), bodyHash), 'utf8')) as Json;
      cache.set(bodyHash, pkg);
    }
    const releases = (pkg['releases'] as Json[] | undefined) ?? [];
    const rel = releases.find((r) => r['id'] === id);
    if (rel === undefined) {
      throw new Error(`release ${id} not found in page ${bodyHash} (find-by-id oracle)`);
    }
    const tags = (rel['tag'] as string[] | undefined) ?? [];
    if (!tags.includes('tender')) continue; // tender-tag filter, incl dual planning,tender
    const scheme = rel['tender']?.['legalBasis']?.['scheme'];
    if (scheme === 'UKPGA') pop.ukpga.push(rel);
    else if (scheme === 'CELEX') pop.celex.push(rel);
    else pop.other.push(rel);
    if (tags.includes('planning')) pop.dualTender.push(rel);
  }
  return pop;
}

const path = (o: any, ...ks: string[]): any =>
  ks.reduce((cur, k) => (cur === null || cur === undefined ? undefined : cur[k]), o);
const has = (v: any): boolean => v !== undefined && v !== null;
const lots = (r: Json): Json[] => (path(r, 'tender', 'lots') as Json[] | undefined) ?? [];
const anyLotPeriod = (r: Json, pred: (cp: Json) => boolean): boolean =>
  lots(r).some((l) => {
    const cp = l['contractPeriod'];
    return cp !== null && cp !== undefined && pred(cp as Json);
  });
const cpvViaAdditional = (r: Json): boolean =>
  ((path(r, 'tender', 'items') as Json[] | undefined) ?? []).some((it) =>
    ((it['additionalClassifications'] as Json[] | undefined) ?? []).some((c) => c['scheme'] === 'CPV'),
  );
const cpvCelex = (r: Json): boolean => {
  const tc = path(r, 'tender', 'classification');
  if (tc !== null && tc !== undefined && !Array.isArray(tc) && (tc as Json)['scheme'] === 'CPV') {
    return true;
  }
  if (Array.isArray(tc) && (tc as Json[]).some((c) => c['scheme'] === 'CPV')) return true;
  return cpvViaAdditional(r);
};

interface UkpgaCoverage {
  n: number;
  amountGross: number;
  coreAmount: number;
  cpv: number;
  lotContractPeriod: number;
  deadline: number;
  mainProcurementCategory: number;
  hasRenewalTrue: number;
}
interface CelexCoverage {
  n: number;
  amount: number;
  cpv: number;
  lotDurationInDays: number;
  lotEndDate: number;
  tenderPeriodEnd: number;
  mainProcurementCategory: number;
}

function ukpgaCoverage(rs: Json[]): UkpgaCoverage {
  const count = (pred: (r: Json) => boolean): number => rs.filter(pred).length;
  return {
    n: rs.length,
    amountGross: count((r) => has(path(r, 'tender', 'value', 'amountGross'))),
    coreAmount: count((r) => has(path(r, 'tender', 'value', 'amount'))),
    cpv: count(cpvViaAdditional),
    lotContractPeriod: count((r) =>
      anyLotPeriod(r, (cp) => has(cp['startDate']) || has(cp['endDate'])),
    ),
    deadline: count(
      (r) =>
        has(path(r, 'tender', 'tenderPeriod', 'endDate')) ||
        has(path(r, 'tender', 'expressionOfInterestDeadline')),
    ),
    mainProcurementCategory: count((r) => has(path(r, 'tender', 'mainProcurementCategory'))),
    hasRenewalTrue: count((r) => lots(r).some((l) => l['hasRenewal'] === true)),
  };
}

function celexCoverage(rs: Json[]): CelexCoverage {
  const count = (pred: (r: Json) => boolean): number => rs.filter(pred).length;
  return {
    n: rs.length,
    amount: count((r) => has(path(r, 'tender', 'value', 'amount'))),
    cpv: count(cpvCelex),
    lotDurationInDays: count((r) => anyLotPeriod(r, (cp) => has(cp['durationInDays']))),
    lotEndDate: count((r) => anyLotPeriod(r, (cp) => has(cp['endDate']))),
    tenderPeriodEnd: count((r) => has(path(r, 'tender', 'tenderPeriod', 'endDate'))),
    mainProcurementCategory: count((r) => has(path(r, 'tender', 'mainProcurementCategory'))),
  };
}

// --- discriminated-union narrowing helpers ---
function asCanonical(r: NormaliseResult): CanonicalTender {
  expect(r.kind).toBe('canonical');
  if (r.kind !== 'canonical') throw new Error(`expected canonical, got ${JSON.stringify(r)}`);
  return r;
}
function asAnomaly(r: NormaliseResult): TenderAnomaly {
  expect(r.kind).toBe('anomaly');
  if (r.kind !== 'anomaly') throw new Error(`expected anomaly, got canonical: ${JSON.stringify(r)}`);
  return r;
}

describe('tender normalisation over the committed corpus (Conditions 1 & 2, §5.3)', () => {
  let root: string;
  let summary: ProjectionSummary;
  let pop: OraclePopulation;
  let ukRaw: UkpgaCoverage;
  let ceRaw: CelexCoverage;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-normalise-'));
    await buildCorpusStore(root);
    summary = projectTenders(root);
    pop = rawTenderOracle(root);
    ukRaw = ukpgaCoverage(pop.ukpga);
    ceRaw = celexCoverage(pop.celex);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('population and regime split (plan step 7 — pinned before any field assertion)', () => {
    it('projects 230 tender releases split 204 UKPGA / 26 CELEX', () => {
      expect(summary.tenderReleases).toBe(230);
      expect(summary.regime.UKPGA).toBe(204);
      expect(summary.regime.CELEX).toBe(26);
    });

    it('the independent raw oracle finds the same 204 / 26 / 0-other split', () => {
      expect(pop.ukpga).toHaveLength(204);
      expect(pop.celex).toHaveLength(26);
      expect(pop.other).toHaveLength(0);
      expect(pop.ukpga.length + pop.celex.length).toBe(summary.tenderReleases);
    });
  });

  describe('Condition 1 — field-presence rates matched to the Phase-0 census', () => {
    it('independent raw oracle matches the pinned UKPGA census counts (n=204)', () => {
      expect(ukRaw.n).toBe(204);
      expect(ukRaw.amountGross).toBe(200); // census 99.1% (core `amount` only 81.7% — must differ)
      expect(ukRaw.coreAmount).toBe(155); // census 81.7% — gross and net kept distinct
      expect(ukRaw.cpv).toBe(204); // census 100% via items[].additionalClassifications
      expect(ukRaw.lotContractPeriod).toBe(200); // census 99.1% lot-level
      expect(ukRaw.deadline).toBe(201); // census 99.2% (tenderPeriod.endDate ∪ EOI)
      expect(ukRaw.mainProcurementCategory).toBe(204); // census 100%
      expect(ukRaw.hasRenewalTrue).toBe(105); // census 53.6% (only-when-true on UKPGA)
    });

    it('independent raw oracle matches the pinned CELEX census counts (n=26)', () => {
      expect(ceRaw.n).toBe(26);
      expect(ceRaw.amount).toBe(18); // census 70.3% (amountGross is 0 on CELEX — zero-guard below)
      expect(ceRaw.cpv).toBe(26); // census 100% via tender.classification
      expect(ceRaw.lotDurationInDays).toBe(20); // census 75.4% — CELEX gives duration
      expect(ceRaw.lotEndDate).toBe(5); // census 20.5% — the CELEX lot endDate branch (m1)
      expect(ceRaw.tenderPeriodEnd).toBe(26); // census 100%
      expect(ceRaw.mainProcurementCategory).toBe(26); // census 100%
    });

    it('normaliser field coverage AGREES with the independent raw oracle — UKPGA (a wrong path disagrees)', () => {
      // Canonical-vs-raw agreement is the wrong-path teeth: the nullable fields
      // (amountGross, coreAmount, lotContractPeriod, deadline, hasRenewalTrue)
      // carry real disagreement signal — a wrong path nulls them and this fails.
      expect(summary.fieldCoverage.ukpga.n).toBe(ukRaw.n);
      expect(summary.fieldCoverage.ukpga.amountGross).toBe(ukRaw.amountGross);
      expect(summary.fieldCoverage.ukpga.coreAmount).toBe(ukRaw.coreAmount);
      expect(summary.fieldCoverage.ukpga.cpv).toBe(ukRaw.cpv);
      expect(summary.fieldCoverage.ukpga.lotContractPeriod).toBe(ukRaw.lotContractPeriod);
      expect(summary.fieldCoverage.ukpga.deadline).toBe(ukRaw.deadline);
      expect(summary.fieldCoverage.ukpga.mainProcurementCategory).toBe(ukRaw.mainProcurementCategory);
      expect(summary.fieldCoverage.ukpga.hasRenewalTrue).toBe(ukRaw.hasRenewalTrue);
    });

    it('normaliser field coverage AGREES with the independent raw oracle — CELEX', () => {
      expect(summary.fieldCoverage.celex.n).toBe(ceRaw.n);
      expect(summary.fieldCoverage.celex.amount).toBe(ceRaw.amount);
      expect(summary.fieldCoverage.celex.cpv).toBe(ceRaw.cpv);
      expect(summary.fieldCoverage.celex.lotDurationInDays).toBe(ceRaw.lotDurationInDays);
      expect(summary.fieldCoverage.celex.lotEndDate).toBe(ceRaw.lotEndDate);
      expect(summary.fieldCoverage.celex.tenderPeriodEnd).toBe(ceRaw.tenderPeriodEnd);
      expect(summary.fieldCoverage.celex.mainProcurementCategory).toBe(ceRaw.mainProcurementCategory);
    });

    it('zero-occurrence input paths are absent across the raw corpus (independent structural guard)', () => {
      // A normaliser re-pointed at any of these decoy paths would read a wrong
      // field yet still "parse"; pinning them at 0 catches that.
      const itemsClassification = [...pop.ukpga, ...pop.celex, ...pop.other].filter((r) =>
        ((path(r, 'tender', 'items') as Json[] | undefined) ?? []).some((it) =>
          has(it['classification']),
        ),
      ).length;
      const tenderLevelContractPeriod = [...pop.ukpga, ...pop.celex, ...pop.other].filter((r) =>
        has(path(r, 'tender', 'contractPeriod')),
      ).length;
      const celexAmountGross = pop.celex.filter((r) =>
        has(path(r, 'tender', 'value', 'amountGross')),
      ).length;
      const celexEoi = pop.celex.filter((r) =>
        has(path(r, 'tender', 'expressionOfInterestDeadline')),
      ).length;

      expect(itemsClassification).toBe(0); // items[].classification never occurs (invariant #11)
      expect(tenderLevelContractPeriod).toBe(0); // tender-level contractPeriod never occurs (sharp-edge 9)
      expect(celexAmountGross).toBe(0); // amountGross is UKPGA-only
      expect(celexEoi).toBe(0); // expressionOfInterestDeadline is UKPGA-only
    });

    it('normaliseTender extracts gross and net distinctly for a known UKPGA release (076447-2026)', () => {
      const raw = pop.ukpga.find((r) => r['id'] === '076447-2026');
      expect(raw).toBeDefined();
      const c = asCanonical(normaliseTender(raw as Json));
      expect(c.regime).toBe('UKPGA');
      expect(c.value.gross).toBe(252000000); // tender.value.amountGross
      expect(c.value.net).toBe(210000000); // tender.value.amount — never mixed with gross
      expect(c.value.currency).toBe('GBP');
    });

    it('normaliseTender reads CELEX value/CPV at CELEX paths for a known release (076444-2026)', () => {
      const raw = pop.celex.find((r) => r['id'] === '076444-2026');
      expect(raw).toBeDefined();
      const c = asCanonical(normaliseTender(raw as Json));
      expect(c.regime).toBe('CELEX');
      expect(c.value.gross).toBeNull(); // no amountGross on CELEX
      expect(c.value.net).toBe(130000); // tender.value.amount
      // CPV comes from CELEX-only tender.classification (object shape), not items[]
      expect(
        c.cpv.some(
          (x: { scheme: string; id: string | null; description: string | null }) =>
            x.scheme === 'CPV' && x.id === '85149000',
        ),
      ).toBe(true);
    });

    it('includes dual planning,tender releases and excludes planning-only / update releases', () => {
      // Both committed dual releases are CELEX and must be in the tender population.
      expect(new Set(pop.dualTender.map((r) => r['id']))).toEqual(
        new Set(['076323-2026', '076069-2026']),
      );
      for (const r of pop.dualTender) {
        expect(pop.celex.some((c) => c['id'] === r['id'])).toBe(true);
      }
      // A planning-only and a tenderUpdate-only release are accepted in the
      // store but must NOT enter the tender population (tag filter).
      const tenderIds = new Set([...pop.ukpga, ...pop.celex, ...pop.other].map((r) => r['id']));
      expect(pop.allAcceptedIds.has('076454-2026')).toBe(true); // planning-only, accepted
      expect(tenderIds.has('076454-2026')).toBe(false); // ...but excluded from tender pop
      expect(tenderIds.has('076459-2026')).toBe(false); // tenderUpdate-only, excluded
    });

    it('canonical projection covers EXACTLY the tender-tagged population by release id', () => {
      const canonIds = new Set(readNdjson(canonicalPath(root)).map((r) => r['releaseId']));
      const oracleIds = new Set([...pop.ukpga, ...pop.celex].map((r) => r['id']));
      expect(canonIds).toEqual(oracleIds); // find-by-id + tender filter, no over/under-reach
    });
  });

  describe('store read surface (readAcceptedReleases / readPageBody, plan step 3)', () => {
    it('readPageBody returns a body that hashes to its recorded bodyHash', () => {
      const accepted = readAcceptedReleases(root);
      expect(accepted.length).toBeGreaterThan(0);
      const first = accepted[0];
      expect(first).toBeDefined();
      const body = readPageBody(root, (first as { bodyHash: string }).bodyHash);
      expect(sha256Hex(body)).toBe((first as { bodyHash: string }).bodyHash);
    });

    it('readPageBody rejects a bodyHash that is not 64-hex (fail loud, replay.ts precedent)', () => {
      expect(() => readPageBody(root, 'not-a-valid-hash')).toThrow();
    });
  });

  describe('Condition 2 — clean corpus yields a near-zero, observable anomaly rate', () => {
    it('records zero anomalies and a zero anomaly rate over the clean 230-release corpus', () => {
      expect(summary.anomalies).toBe(0);
      expect(summary.anomalyRate).toBe(0);
      expect(summary.canonical).toBe(230);
    });

    it('writes one canonical line per canonical record and an empty anomalies projection', () => {
      expect(readNdjson(canonicalPath(root))).toHaveLength(summary.canonical);
      expect(readNdjson(anomaliesPath(root))).toHaveLength(summary.anomalies);
      expect(readNdjson(anomaliesPath(root))).toHaveLength(0);
    });
  });

  describe('§5.3 determinism — a re-run re-derives byte-identical output', () => {
    it('re-running the projection yields byte-identical canonical and anomalies files', () => {
      const canon1 = readBytesOrEmpty(canonicalPath(root));
      const anom1 = readBytesOrEmpty(anomaliesPath(root));
      projectTenders(root); // full rebuild over the same raw store
      const canon2 = readBytesOrEmpty(canonicalPath(root));
      const anom2 = readBytesOrEmpty(anomaliesPath(root));
      expect(canon2.equals(canon1)).toBe(true);
      expect(anom2.equals(anom1)).toBe(true);
    });

    it('re-running the projection yields a deep-equal summary', () => {
      expect(projectTenders(root)).toEqual(summary);
    });

    it('reports an inspectable projection summary (executed-run numbers)', () => {
      // Captures the run's numbers in test output for the acceptance's
      // "numbers inspected and reported".
      // eslint-disable-next-line no-console
      console.log(
        `[normalise] tenderReleases=${summary.tenderReleases} ` +
          `UKPGA=${summary.regime.UKPGA} CELEX=${summary.regime.CELEX} ` +
          `canonical=${summary.canonical} anomalies=${summary.anomalies} ` +
          `anomalyRate=${summary.anomalyRate}`,
      );
      expect(summary.tenderReleases).toBe(230);
      expect(summary.canonical + summary.anomalies).toBe(summary.tenderReleases);
    });
  });
});

// -----------------------------------------------------------------------------
// Condition 2 — the pure core fails LOUD on labelled-synthetic unmapped inputs.
// Each release below is SYNTHETIC (the committed corpus has 0 malformed records,
// package-shape §6); each isolates exactly one defect against an otherwise valid
// template, so the reason is unambiguous whatever order the core checks in.
// -----------------------------------------------------------------------------

function validUkpga(): Json {
  return {
    id: 'syn-uk',
    ocid: 'ocds-syn-uk',
    tag: ['tender'],
    date: '2026-09-01T00:00:00+01:00',
    tender: {
      legalBasis: { scheme: 'UKPGA' },
      mainProcurementCategory: 'services',
      items: [
        { additionalClassifications: [{ scheme: 'CPV', id: '45220000', description: 'Works' }] },
      ],
      documents: [{ noticeType: 'UK4' }],
      value: { amountGross: 1000, amount: 900, currency: 'GBP' },
      tenderPeriod: { endDate: '2026-12-01T00:00:00+00:00' },
      lots: [
        {
          id: 'lot-1',
          contractPeriod: {
            startDate: '2027-01-01T00:00:00+00:00',
            endDate: '2028-01-01T00:00:00+00:00',
          },
          hasRenewal: true,
          renewal: { description: 'renewable' },
        },
      ],
    },
  };
}

function validCelex(): Json {
  return {
    id: 'syn-ce',
    ocid: 'ocds-syn-ce',
    tag: ['tender'],
    date: '2026-09-01T00:00:00+01:00',
    tender: {
      legalBasis: { scheme: 'CELEX' },
      mainProcurementCategory: 'services',
      classification: { scheme: 'CPV', id: '71221000', description: 'Architectural' },
      value: { amount: 130000, currency: 'GBP' },
      tenderPeriod: { endDate: '2026-12-01T00:00:00+00:00' },
      lots: [{ id: 'lot-1', contractPeriod: { durationInDays: 365 } }],
    },
  };
}

/** Clone the valid UKPGA template and apply one mutation (the sole defect). */
function mutateUkpga(mutate: (r: Json) => void): Json {
  const r = structuredClone(validUkpga());
  mutate(r);
  return r;
}

describe('normaliseTender — labelled-synthetic unmapped inputs fail loud (Condition 2)', () => {
  it('normalises a well-formed UKPGA release to a canonical record', () => {
    const c = asCanonical(normaliseTender(validUkpga()));
    expect(c.regime).toBe('UKPGA');
    expect(c.value.gross).toBe(1000);
    expect(c.value.net).toBe(900);
  });

  it('normalises a well-formed CELEX release to a canonical record', () => {
    const c = asCanonical(normaliseTender(validCelex()));
    expect(c.regime).toBe('CELEX');
    expect(c.value.gross).toBeNull();
    expect(c.value.net).toBe(130000);
  });

  it('flags an unknown legalBasis.scheme as an unknown-regime anomaly', () => {
    const a = asAnomaly(
      normaliseTender(mutateUkpga((r) => ((r['tender'] as Json)['legalBasis'] = { scheme: 'MADE-UP' }))),
    );
    expect(a.reason).toBe('unknown-regime');
    expect(a.releaseId).toBe('syn-uk');
  });

  it('flags a missing legalBasis.scheme as a missing-legal-basis-scheme anomaly', () => {
    const a = asAnomaly(
      normaliseTender(mutateUkpga((r) => delete (r['tender'] as Json)['legalBasis'])),
    );
    expect(a.reason).toBe('missing-legal-basis-scheme');
  });

  it('flags a tender-tagged release with no tender block as a missing-tender-block anomaly', () => {
    const a = asAnomaly(normaliseTender(mutateUkpga((r) => delete r['tender'])));
    expect(a.reason).toBe('missing-tender-block');
  });

  it('flags a missing mainProcurementCategory as a missing-main-procurement-category anomaly', () => {
    const a = asAnomaly(
      normaliseTender(mutateUkpga((r) => delete (r['tender'] as Json)['mainProcurementCategory'])),
    );
    expect(a.reason).toBe('missing-main-procurement-category');
  });

  it('flags a UKPGA release with no CPV as a missing-cpv anomaly', () => {
    // items present but no additionalClassifications, and not at the CELEX path.
    const a = asAnomaly(normaliseTender(mutateUkpga((r) => ((r['tender'] as Json)['items'] = [{}]))));
    expect(a.reason).toBe('missing-cpv');
  });

  it('flags an unrecognised UKPGA noticeType as an unknown-notice-type anomaly', () => {
    const a = asAnomaly(
      normaliseTender(
        mutateUkpga((r) => ((r['tender'] as Json)['documents'] = [{ noticeType: 'UK99' }])),
      ),
    );
    expect(a.reason).toBe('unknown-notice-type');
  });

  it('never returns a coerced canonical record for any unmapped input', () => {
    const bad = [
      mutateUkpga((r) => ((r['tender'] as Json)['legalBasis'] = { scheme: 'MADE-UP' })),
      mutateUkpga((r) => delete r['tender']),
      mutateUkpga((r) => delete (r['tender'] as Json)['mainProcurementCategory']),
      mutateUkpga((r) => ((r['tender'] as Json)['items'] = [{}])),
      mutateUkpga((r) => ((r['tender'] as Json)['documents'] = [{ noticeType: 'UK99' }])),
    ];
    for (const r of bad) {
      expect(normaliseTender(r).kind).toBe('anomaly');
    }
  });

  it('does not throw on a hostile deeply-nested CPV id — nulls the id, keeps the run alive (S-m1)', () => {
    // A pathologically deep nested-array `id` makes `String(id)` throw a
    // RangeError; uncaught in normaliseTender it unwinds to the CLI try/catch and
    // aborts the WHOLE-store projection. The guarded coercion (safeStr) coerces only
    // safe scalar ids and nulls a non-scalar one, so one hostile release cannot
    // kill the run. The deep array is applied AFTER structuredClone, so the clone
    // never touches it.
    let deep: unknown = [];
    for (let i = 0; i < 40000; i++) deep = [deep];
    const rel = mutateUkpga((r) => {
      (r['tender'] as Json)['items'] = [
        { additionalClassifications: [{ scheme: 'CPV', id: deep, description: 'hostile' }] },
      ];
    });

    let result: NormaliseResult | undefined;
    expect(() => {
      result = normaliseTender(rel);
    }).not.toThrow();

    // The CPV entry survives with a null id (not dropped, not a throw); the
    // release stays canonical rather than aborting the projection.
    const c = asCanonical(result as NormaliseResult);
    expect(c.cpv).toHaveLength(1);
    expect(c.cpv[0]?.id).toBeNull();
    expect(c.cpv[0]?.scheme).toBe('CPV');
  });

  it('does not throw on a hostile deeply-nested legalBasis.scheme — anomalises the release, keeps the run alive (S-m3)', () => {
    // Sibling of the S-m1 CPV-id case: a pathologically deep nested-array `scheme`
    // makes `String(scheme)` throw a RangeError in the unknown-regime branch;
    // uncaught in normaliseTender it unwinds to the CLI try/catch and aborts the
    // WHOLE-store projection. The shared `safeStr` guard nulls a non-scalar scheme
    // instead, so one hostile release resolves to a clean `unknown-regime` anomaly
    // rather than killing the run. The deep array is applied AFTER structuredClone,
    // so the clone never touches it.
    let deep: unknown = [];
    for (let i = 0; i < 40000; i++) deep = [deep];
    const rel = mutateUkpga((r) => {
      (r['tender'] as Json)['legalBasis'] = { scheme: deep };
    });

    let result: NormaliseResult | undefined;
    expect(() => {
      result = normaliseTender(rel);
    }).not.toThrow();

    // Fail-loud at RELEASE granularity: a clean unknown-regime anomaly, not a
    // run-aborting throw. The non-scalar scheme is nulled, not String()-coerced.
    const a = asAnomaly(result as NormaliseResult);
    expect(a.reason).toBe('unknown-regime');
    expect(a.releaseId).toBe('syn-uk');
    expect(a.regime).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Condition 2 — the projection surfaces an anomaly COUNT + RATE (not a log line)
// over a store seeded with labelled-synthetic anomalies alongside a valid record.
// -----------------------------------------------------------------------------

describe('projection reports an observable anomaly count + rate (Condition 2)', () => {
  let root: string;
  let synSummary: ProjectionSummary;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-normalise-anom-'));
    const window = { updatedFrom: '2026-09-01T00:00:00', updatedTo: '2026-09-02T00:00:00' };
    const url = `${BASE}?updatedFrom=2026-09-01T00:00:00&updatedTo=2026-09-02T00:00:00&limit=100`;

    const releases: Json[] = [
      validUkpga(), // 1 canonical
      { id: 'syn-ur', ocid: 'ocds-syn-ur', tag: ['tender'], date: '2026-09-01T00:00:00+01:00',
        tender: { legalBasis: { scheme: 'MADE-UP' }, mainProcurementCategory: 'services',
          items: [{ additionalClassifications: [{ scheme: 'CPV', id: '45220000' }] }],
          documents: [{ noticeType: 'UK4' }] } }, // unknown-regime
      { id: 'syn-mt', ocid: 'ocds-syn-mt', tag: ['tender'], date: '2026-09-01T00:00:00+01:00' }, // missing-tender-block
      { id: 'syn-mc', ocid: 'ocds-syn-mc', tag: ['tender'], date: '2026-09-01T00:00:00+01:00',
        tender: { legalBasis: { scheme: 'UKPGA' }, mainProcurementCategory: 'services',
          items: [{}], documents: [{ noticeType: 'UK4' }] } }, // missing-cpv
    ];
    const body = new TextEncoder().encode(JSON.stringify({ uri: url, releases }));
    const exchange: RecordedExchange = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    };

    const clock = makeVirtualClock(T0);
    const { sleep } = makeVirtualSleep(clock);
    const { transport } = makeFixtureTransport({ [url]: [exchange] });
    const store = createRawStore(root, { now: clock.now });
    await ingestWindow({ transport, sleep, now: clock.now, store }, window);

    synSummary = projectTenders(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports the anomaly count and rate as summary outputs, not just logs', () => {
    expect(synSummary.tenderReleases).toBe(4);
    expect(synSummary.canonical).toBe(1);
    expect(synSummary.anomalies).toBe(3);
    expect(synSummary.anomalyRate).toBeCloseTo(3 / 4, 10);
    // The rate is the reported ratio over the tender population.
    expect(synSummary.anomalyRate).toBe(synSummary.anomalies / synSummary.tenderReleases);
  });

  it('writes one anomalies.ndjson record per anomaly, each carrying its reason', () => {
    const anomalies = readNdjson(anomaliesPath(root));
    expect(anomalies).toHaveLength(synSummary.anomalies);
    expect(new Set(anomalies.map((a) => a['reason']))).toEqual(
      new Set(['unknown-regime', 'missing-tender-block', 'missing-cpv']),
    );
  });

  it('keeps the valid release as a canonical record, not coerced away', () => {
    const canonical = readNdjson(canonicalPath(root));
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.['releaseId']).toBe('syn-uk');
  });
});
