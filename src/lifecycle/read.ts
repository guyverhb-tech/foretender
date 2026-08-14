/**
 * The grouped-by-ocid store reader shared by the prediction and grading
 * projections. Placed in the lifecycle layer — the shared DOWNWARD home both
 * layers already depend on — so the single copy of the read/dedup/group contract
 * lives in one place, and neither layer imports the other (§5.1: grading never
 * imports prediction).
 *
 * The spine: read the accepted-release projection, cache each page body by its
 * content hash, find each release by id (fail loud on a miss — the projection
 * points at a body that MUST contain it), dedup by release id, lift to a
 * `LifecycleEvent`, and group into a `Map<string, LifecycleEvent[]>` keyed by ocid.
 *
 * This hosts the grouped-by-ocid shape ONLY. The shipped `lifecycle/project.ts`
 * (flat array feeding `reconstructMany`) and `normalise/project.ts` (tender-
 * filtered) read the same store into DIFFERENT shapes and deliberately stay apart.
 */
import { readAcceptedReleases, readPageBody } from '../store/raw-store.js';
import { toLifecycleEvent } from './event.js';
import type { LifecycleEvent } from './model.js';

interface PackagePage {
  releases?: unknown[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** NDJSON: one record per line, trailing newline; an empty list yields an empty file. */
export const toNdjson = (records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

/** Build per-ocid event streams from the raw store, deduped by release id. */
export function readEventsByOcid(rootDir: string): Map<string, LifecycleEvent[]> {
  const accepted = readAcceptedReleases(rootDir);
  const pageCache = new Map<string, PackagePage>();
  const seenIds = new Set<string>();
  const byOcid = new Map<string, LifecycleEvent[]>();

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
    const ev = toLifecycleEvent(release);
    let group = byOcid.get(ev.ocid);
    if (group === undefined) {
      group = [];
      byOcid.set(ev.ocid, group);
    }
    group.push(ev);
  }
  return byOcid;
}
