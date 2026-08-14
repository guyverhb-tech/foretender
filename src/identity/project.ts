/**
 * The identity projection over an existing raw store (slice 6; §5.3). Offline
 * and pure disk I/O: it reads the append-only store, groups EVERY accepted
 * release (all tags, not just tenders) by ocid, resolves one `Identity` per
 * ocid, and rebuilds the DERIVED sibling file `identities.ndjson` plus an
 * `IdentitySummary` (ocid count + per-field presence counts and rates).
 *
 * Like `lifecycle/project.ts` this is a deterministic FULL REBUILD (truncate-
 * then-write in ocid-sorted order with fixed key order), sanctioned for §5.3
 * replay: two runs over the same raw store produce byte-identical output. The
 * raw store stays append-only; only this derived view is rebuilt. A partial file
 * on interrupt is acceptable — the next run rebuilds it wholesale.
 *
 * The read/dedup spine mirrors `lifecycle/project.ts` but groups the RAW release
 * bodies (which the resolver needs for title/buyer/value), not lifted events, so
 * it reuses the store read surface and `toNdjson` rather than `readEventsByOcid`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toNdjson } from '../lifecycle/read.js';
import { readAcceptedReleases, readPageBody } from '../store/raw-store.js';
import { extractIdentity } from './extract.js';
import type { Identity, IdentitySummary } from './model.js';

interface PackagePage {
  releases?: unknown[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function projectIdentities(rootDir: string): IdentitySummary {
  const accepted = readAcceptedReleases(rootDir);
  const pageCache = new Map<string, PackagePage>();
  const seenIds = new Set<string>();
  const byOcid = new Map<string, unknown[]>();

  for (const rec of accepted) {
    let pkg = pageCache.get(rec.bodyHash);
    if (pkg === undefined) {
      const body = readPageBody(rootDir, rec.bodyHash);
      pkg = JSON.parse(new TextDecoder().decode(body)) as PackagePage;
      pageCache.set(rec.bodyHash, pkg);
    }
    const releases = Array.isArray(pkg.releases) ? pkg.releases : [];
    const release = releases.find((r) => isObject(r) && r['id'] === rec.id);
    if (release === undefined) {
      // The accepted-release projection points at a body that must contain it by
      // id; a miss means a tampered/mismatched store, so fail loud.
      throw new Error(`release ${rec.id} not found in page ${rec.bodyHash}`);
    }
    // Dedup by release id (invariant #6): defensive against the whole-stream ∩
    // backfill window overlap, mirroring the lifecycle projection.
    if (seenIds.has(rec.id)) continue;
    seenIds.add(rec.id);
    // Group by the accepted-release ocid — the store's authoritative identity.
    let group = byOcid.get(rec.ocid);
    if (group === undefined) {
      group = [];
      byOcid.set(rec.ocid, group);
    }
    group.push(release);
  }

  // ocid-ascending so the rebuild is order-independent of Map insertion order.
  const identities: Identity[] = [...byOcid.keys()]
    .sort()
    .map((ocid) => extractIdentity(ocid, byOcid.get(ocid) ?? []));

  writeFileSync(join(rootDir, 'identities.ndjson'), toNdjson(identities));

  const n = identities.length;
  const count = (pred: (i: Identity) => boolean): number => identities.filter(pred).length;
  const title = count((i) => i.title !== null);
  const buyer = count((i) => i.buyer !== null);
  const gross = count((i) => i.value.gross !== null);
  const net = count((i) => i.value.net !== null);
  const currency = count((i) => i.value.currency !== null);
  const rate = (c: number): number => (n === 0 ? 0 : c / n);

  return {
    ocids: n,
    title,
    buyer,
    gross,
    net,
    currency,
    rate: {
      title: rate(title),
      buyer: rate(buyer),
      gross: rate(gross),
      net: rate(net),
      currency: rate(currency),
    },
  };
}
