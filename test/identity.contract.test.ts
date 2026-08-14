import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestWindow } from '../src/ingest/ingest.js';
import { createRawStore, readAcceptedReleases, readPageBody } from '../src/store/raw-store.js';
import { extractIdentity } from '../src/identity/extract.js';
import { projectIdentities } from '../src/identity/project.js';
import type { Identity, IdentitySummary } from '../src/identity/model.js';
import { loadBackfillDay, makeFixtureTransport, wholeStreamChain } from './helpers/fixture-transport.js';
import { makeVirtualClock, makeVirtualSleep, readNdjson } from './helpers/support.js';

/**
 * Per-ocid identity contract (slice 6) — fixture-only, zero network. The store
 * is built through the injected fixture transport; the setup.ts globalThis.fetch
 * poison is the backstop, so any accidental wire touch fails loudly.
 *
 * TWO LOAD-BEARING PROPERTIES this suite bites on:
 *
 *   Condition 1 (field-presence RATES matched to an INDEPENDENT raw-body oracle).
 *   `rawIdentityOracle` re-resolves each ocid's title/buyer/value/sourceReleaseId
 *   by traversing OCDS paths directly — it NEVER calls the extractor — with its
 *   own local latest-by-numeric-id order. A wrong path in the extractor makes the
 *   projection's per-ocid resolution DISAGREE with the oracle. Because title and
 *   buyer are both 100% here, the wrong-path signal is: the extractor's presence
 *   count collapses while the oracle's holds (e.g. re-pointing title drops the
 *   projection's title count to 0 against the oracle's 1492). The nullable value
 *   fields (gross/net/currency, each a DIFFERENT count) carry the same signal.
 *
 *   LATEST-non-null resolution + determinism (§5.3). Each field is the value from
 *   the LATEST release (by numeric notice id) that provides one; a full rebuild is
 *   byte-identical across runs. The buyer `parties[]` fallback is load-bearing —
 *   name-only resolves 1462 ocids, name∪parties resolves 1492 (30 recovered).
 *
 * Authoritative fixture population (disk-derived; the same 1492 ocids / 1624
 * deduped releases the lifecycle projection reconstructs). A missing title/buyer
 * on some notices is NORMAL — this projection records a presence RATE and has no
 * anomaly channel; it never fails loud on absence.
 *
 * Interface assumptions:
 *   extractIdentity(ocid: string, releases: readonly unknown[]): Identity
 *   projectIdentities(rootDir: string): IdentitySummary   // synchronous full rebuild
 *   store sibling <root>/identities.ndjson
 */

type Json = Record<string, any>;

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

/** Every committed ocid shares this prefix (verified over the corpus). */
const oc = (suffix: string): string => `ocds-h6vhtk-${suffix}`;

const identitiesPath = (root: string): string => join(root, 'identities.ndjson');
const readBytesOrEmpty = (p: string): Buffer => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));

/**
 * Build ONE temp store from the committed fixtures exactly as the tender and
 * lifecycle contract tests do: ingest the whole-stream chain then each backfill
 * day on one shared virtual clock (cross-run pacing is real but instantaneous
 * under virtual sleep). Dedupe is the store's own frozen-snapshot dedupe on
 * release `id`.
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

// --- Independent structural resolver over the RAW fixture bodies (Condition 1) ---
// Deliberately NOT the extractor: it traverses OCDS paths directly with its own
// latest-by-numeric-id order, so a wrong path in the extractor produces a
// per-ocid DISAGREEMENT between the projection and this oracle.

/** Group each ocid's raw release bodies from the store's accepted projection. */
function rawReleasesByOcid(root: string): Map<string, Json[]> {
  const accepted = readAcceptedReleases(root);
  const cache = new Map<string, Json>();
  const seen = new Set<string>();
  const byOcid = new Map<string, Json[]>();
  for (const rec of accepted) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    let pkg = cache.get(rec.bodyHash);
    if (pkg === undefined) {
      pkg = JSON.parse(new TextDecoder().decode(readPageBody(root, rec.bodyHash))) as Json;
      cache.set(rec.bodyHash, pkg);
    }
    const rel = ((pkg['releases'] as Json[] | undefined) ?? []).find((r) => r['id'] === rec.id);
    if (rel === undefined) throw new Error(`release ${rec.id} not found in page ${rec.bodyHash}`);
    let group = byOcid.get(rec.ocid);
    if (group === undefined) {
      group = [];
      byOcid.set(rec.ocid, group);
    }
    group.push(rel);
  }
  return byOcid;
}

/** A local numeric-id order independent of the machine's `compareReleaseId`. */
function idKey(id: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(id ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [Infinity, Infinity];
}
function cmpId(a: string, b: string): number {
  const [na, ya] = idKey(a);
  const [nb, yb] = idKey(b);
  if (na !== nb) return na - nb;
  if (ya !== yb) return ya - yb;
  return a < b ? -1 : a > b ? 1 : 0;
}

const rawId = (r: Json): string => (typeof r['id'] === 'string' ? r['id'] : '');
const rawTitle = (r: Json): string | null => {
  const t = r['tender']?.['title'];
  if (typeof t === 'string') return t;
  const p = r['planning']?.['title'];
  return typeof p === 'string' ? p : null;
};
const rawBuyer = (r: Json): string | null => {
  const bn = r['buyer']?.['name'];
  if (typeof bn === 'string') return bn;
  for (const party of (r['parties'] as Json[] | undefined) ?? []) {
    if (((party['roles'] as unknown[] | undefined) ?? []).includes('buyer') && typeof party['name'] === 'string') {
      return party['name'] as string;
    }
  }
  return null;
};
const rawBuyerNameOnly = (r: Json): string | null =>
  typeof r['buyer']?.['name'] === 'string' ? (r['buyer']['name'] as string) : null;
const rawGross = (r: Json): number | null =>
  typeof r['tender']?.['value']?.['amountGross'] === 'number' ? (r['tender']['value']['amountGross'] as number) : null;
const rawNet = (r: Json): number | null =>
  typeof r['tender']?.['value']?.['amount'] === 'number' ? (r['tender']['value']['amount'] as number) : null;
const rawCurrency = (r: Json): string | null =>
  typeof r['tender']?.['value']?.['currency'] === 'string' ? (r['tender']['value']['currency'] as string) : null;

/** Latest release (by id) yielding a non-null value for `read`, and which one it was. */
function latest<T>(rels: Json[], read: (r: Json) => T | null): { value: T | null; releaseId: string | null } {
  const sorted = [...rels].sort((a, b) => cmpId(rawId(a), rawId(b)));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    if (r === undefined) continue;
    const value = read(r);
    if (value !== null) return { value, releaseId: rawId(r) };
  }
  return { value: null, releaseId: null };
}

/** Resolve one ocid's identity the independent way, mirroring the record shape. */
function oracleIdentity(ocid: string, rels: Json[]): Identity {
  const title = latest(rels, rawTitle);
  return {
    ocid,
    title: title.value,
    buyer: latest(rels, rawBuyer).value,
    value: {
      gross: latest(rels, rawGross).value,
      net: latest(rels, rawNet).value,
      currency: latest(rels, rawCurrency).value,
    },
    sourceReleaseId: title.releaseId,
  };
}

interface OracleCensus {
  ocids: number;
  title: number;
  buyer: number;
  buyerNameOnly: number;
  gross: number;
  net: number;
  currency: number;
}
function oracleCensus(byOcid: Map<string, Json[]>): OracleCensus {
  let title = 0, buyer = 0, buyerNameOnly = 0, gross = 0, net = 0, currency = 0;
  for (const rels of byOcid.values()) {
    if (latest(rels, rawTitle).value !== null) title++;
    if (latest(rels, rawBuyer).value !== null) buyer++;
    if (latest(rels, rawBuyerNameOnly).value !== null) buyerNameOnly++;
    if (latest(rels, rawGross).value !== null) gross++;
    if (latest(rels, rawNet).value !== null) net++;
    if (latest(rels, rawCurrency).value !== null) currency++;
  }
  return { ocids: byOcid.size, title, buyer, buyerNameOnly, gross, net, currency };
}

/** A hand-built raw release for the pure-extractor units. */
const rel = (id: string, body: Json): Json => ({ id, ...body });

describe('per-ocid identity over the committed corpus (Condition 1, latest-wins, §5.3)', () => {
  let root: string;
  let summary: IdentitySummary;
  let byOcid: Map<string, Json[]>;
  let census: OracleCensus;
  let projected: Map<string, Identity>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-identity-'));
    await buildCorpusStore(root);
    summary = projectIdentities(root);
    byOcid = rawReleasesByOcid(root);
    census = oracleCensus(byOcid);
    projected = new Map(
      (readNdjson(identitiesPath(root)) as unknown as Identity[]).map((i) => [i.ocid, i]),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('population + presence census (pinned before any field assertion)', () => {
    it('resolves 1492 identities — one per ocid, matching the lifecycle population', () => {
      expect(summary.ocids).toBe(1492);
      expect(census.ocids).toBe(1492);
      expect(projected.size).toBe(1492);
    });

    it('pins the independent-oracle presence counts (title/buyer 100%, value fields partial)', () => {
      expect(census.title).toBe(1492); // tender.title present on every ocid
      expect(census.buyer).toBe(1492); // buyer.name ∪ parties[buyer] present on every ocid
      expect(census.gross).toBe(338); // UK amountGross — 22.7%
      expect(census.net).toBe(298); // core amount — 20.0% (distinct from gross)
      expect(census.currency).toBe(365); // 24.5%
    });
  });

  describe('Condition 1 — projection coverage AGREES with the independent raw oracle', () => {
    it('summary presence counts equal the oracle counts (a wrong path disagrees)', () => {
      expect(summary.title).toBe(census.title);
      expect(summary.buyer).toBe(census.buyer);
      expect(summary.gross).toBe(census.gross);
      expect(summary.net).toBe(census.net);
      expect(summary.currency).toBe(census.currency);
    });

    it('reported rates are the counts over the ocid population', () => {
      expect(summary.rate.title).toBeCloseTo(summary.title / summary.ocids, 12);
      expect(summary.rate.buyer).toBeCloseTo(summary.buyer / summary.ocids, 12);
      expect(summary.rate.gross).toBeCloseTo(summary.gross / summary.ocids, 12);
      expect(summary.rate.net).toBeCloseTo(summary.net / summary.ocids, 12);
      expect(summary.rate.currency).toBeCloseTo(summary.currency / summary.ocids, 12);
    });

    it('every projected identity deep-equals the independent oracle resolution', () => {
      // The strongest wrong-path teeth: not just counts but each resolved
      // title/buyer/value/sourceReleaseId matches a second, independent traversal.
      let mismatches = 0;
      for (const [ocid, rels] of byOcid) {
        const got = projected.get(ocid);
        expect(got).toBeDefined();
        if (JSON.stringify(got) !== JSON.stringify(oracleIdentity(ocid, rels))) mismatches++;
      }
      expect(mismatches).toBe(0);
    });
  });

  describe('the buyer parties[] fallback is load-bearing', () => {
    it('name-only resolves 1462 ocids; name∪parties resolves 1492 (30 recovered)', () => {
      // If the extractor dropped the parties fallback its buyer count would fall to
      // 1462 and disagree with the pinned summary/oracle 1492 above.
      expect(census.buyerNameOnly).toBe(1462);
      expect(census.buyer).toBe(1492);
      expect(census.buyer - census.buyerNameOnly).toBe(30);
    });

    it('0605ce (a cancellation with no buyer.name) resolves its buyer from parties[]', () => {
      const id = projected.get(oc('0605ce'));
      expect(id).toBeDefined();
      expect(id?.buyer).toBe('Wiltshire Council'); // from parties[roles∋buyer].name
    });
  });

  describe('LATEST-non-null resolution + the acceptance ocids', () => {
    it('06b607 title comes from the LATEST release (076916 tenderUpdate), not the base notice', () => {
      // Releases 075911/076324 carry "Banking Services for Client Property and Money
      // Management"; the latest release 076916 (a tenderUpdate) reworded it. The
      // brief's LATEST-by-numeric-id rule therefore carries the reworded title, and
      // sourceReleaseId records which release supplied it.
      const id = projected.get(oc('06b607'));
      expect(id).toEqual({
        ocid: oc('06b607'),
        title: 'Banking service to support the Client Property and Money Management Service',
        buyer: 'London Borough of Lewisham',
        value: { gross: 210000, net: 175000, currency: 'GBP' },
        sourceReleaseId: '076916-2026',
      });
    });

    it('050993 (single planning release) resolves title/buyer/value', () => {
      expect(projected.get(oc('050993'))).toEqual({
        ocid: oc('050993'),
        title: 'Portsmouth International Port - Repairs & Maintenance Support Staff and Ancillary Services',
        buyer: 'Portsmouth City Council',
        value: { gross: 4800000, net: 4000000, currency: 'GBP' },
        sourceReleaseId: '076315-2026',
      });
    });

    it('06e21a (planning + tender, identical titles) resolves to the latest (tender) source', () => {
      expect(projected.get(oc('06e21a'))).toEqual({
        ocid: oc('06e21a'),
        title: 'The Supply of Injection moulding Machines to HMP Ranby',
        buyer: 'Ministry of Justice',
        value: { gross: 550000, net: 458000, currency: 'GBP' },
        sourceReleaseId: '076632-2026', // the tender (076632) outranks the planning (076561)
      });
    });
  });

  describe('§5.3 determinism — a full rebuild re-derives byte-identical output', () => {
    it('re-running the projection yields a byte-identical identities file', () => {
      const first = readBytesOrEmpty(identitiesPath(root));
      projectIdentities(root); // full rebuild over the same raw store
      const second = readBytesOrEmpty(identitiesPath(root));
      expect(second.equals(first)).toBe(true);
    });

    it('re-running the projection yields a deep-equal summary', () => {
      expect(projectIdentities(root)).toEqual(summary);
    });

    it('writes one identity line per ocid, ocid-sorted', () => {
      const records = readNdjson(identitiesPath(root));
      expect(records).toHaveLength(summary.ocids);
      const ocids = records.map((r) => r['ocid'] as string);
      expect([...ocids].sort()).toEqual(ocids);
    });

    it('reports an inspectable projection summary (executed-run numbers)', () => {
      // eslint-disable-next-line no-console
      console.log(
        `[identity] ocids=${summary.ocids} ` +
          `title=${summary.title} buyer=${summary.buyer} ` +
          `gross=${summary.gross} net=${summary.net} currency=${summary.currency} ` +
          `titleRate=${summary.rate.title} buyerRate=${summary.rate.buyer}`,
      );
      expect(summary.ocids).toBe(1492);
    });
  });
});

// -----------------------------------------------------------------------------
// The pure resolver: latest-wins, deterministic tie-break, safe on hostile
// values, and order-independent. Hand-built releases — the corpus carries no
// malformed records, so these are labelled-synthetic witnesses.
// -----------------------------------------------------------------------------
describe('extractIdentity — pure per-ocid resolution', () => {
  it('resolves each field from the LATEST release by numeric notice id', () => {
    const id = extractIdentity(oc('t'), [
      rel('000001-2026', { tender: { title: 'old', value: { amountGross: 100, amount: 90, currency: 'GBP' } } }),
      rel('000002-2026', { tender: { title: 'new', value: { amountGross: 200, amount: 180, currency: 'EUR' } } }),
    ]);
    expect(id.title).toBe('new');
    expect(id.sourceReleaseId).toBe('000002-2026');
    expect(id.value).toEqual({ gross: 200, net: 180, currency: 'EUR' });
  });

  it('falls back to an earlier release for a field the latest release omits', () => {
    const id = extractIdentity(oc('t'), [
      rel('000001-2026', { tender: { title: 'only here', value: { amountGross: 500, amount: 400, currency: 'GBP' } } }),
      rel('000002-2026', { tender: {} }), // latest carries no title/value
    ]);
    expect(id.title).toBe('only here');
    expect(id.sourceReleaseId).toBe('000001-2026');
    expect(id.value).toEqual({ gross: 500, net: 400, currency: 'GBP' });
  });

  it('is order-independent — any input permutation yields the same identity', () => {
    const releases = [
      rel('000010-2026', { tender: { title: 'c' } }),
      rel('000002-2026', { tender: { title: 'a' } }),
      rel('000005-2026', { tender: { title: 'b' } }),
    ];
    const base = extractIdentity(oc('t'), releases);
    expect(base.title).toBe('c'); // 000010 is the latest
    expect(extractIdentity(oc('t'), [...releases].reverse())).toEqual(base);
  });

  it('breaks a numeric-id tie by year (the total order), latest year wins', () => {
    const id = extractIdentity(oc('t'), [
      rel('000005-2025', { tender: { title: 'earlier year' } }),
      rel('000005-2026', { tender: { title: 'later year' } }),
    ]);
    expect(id.title).toBe('later year');
    expect(id.sourceReleaseId).toBe('000005-2026');
  });

  it('gross and net stay distinct — a gross-only release nulls net', () => {
    const id = extractIdentity(oc('t'), [
      rel('000001-2026', { tender: { value: { amountGross: 1000, currency: 'GBP' } } }),
    ]);
    expect(id.value).toEqual({ gross: 1000, net: null, currency: 'GBP' });
  });

  it('prefers buyer.name, falling back to the parties[] buyer role', () => {
    const withName = extractIdentity(oc('t'), [
      rel('000001-2026', { buyer: { name: 'Named Buyer' }, parties: [{ roles: ['buyer'], name: 'Party Buyer' }] }),
    ]);
    expect(withName.buyer).toBe('Named Buyer');

    const partiesOnly = extractIdentity(oc('t'), [
      rel('000001-2026', { parties: [{ roles: ['supplier'], name: 'Not It' }, { roles: ['buyer'], name: 'Party Buyer' }] }),
    ]);
    expect(partiesOnly.buyer).toBe('Party Buyer');
  });

  it('does not throw on a hostile deeply-nested title — nulls it, keeps resolving', () => {
    let deep: unknown = [];
    for (let i = 0; i < 40000; i++) deep = [deep];
    let id: Identity | undefined;
    expect(() => {
      id = extractIdentity(oc('t'), [
        rel('000002-2026', { tender: { title: deep } }), // hostile latest title
        rel('000001-2026', { tender: { title: 'safe earlier' } }),
      ]);
    }).not.toThrow();
    // The hostile title is nulled (not String()-coerced), so resolution falls back.
    expect(id?.title).toBe('safe earlier');
    expect(id?.sourceReleaseId).toBe('000001-2026');
  });

  it('resolves an empty release list to an all-null identity', () => {
    expect(extractIdentity(oc('t'), [])).toEqual({
      ocid: oc('t'),
      title: null,
      buyer: null,
      value: { gross: null, net: null, currency: null },
      sourceReleaseId: null,
    });
  });
});
