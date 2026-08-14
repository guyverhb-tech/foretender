/**
 * The grouped-by-ocid store readers over one shared read/dedup spine
 * (`dedupedReleases`, below): `readEventsByOcid` feeds the prediction and grading
 * projections; `readReleasesByOcid` feeds the model predictor's identity join.
 * Placed in the lifecycle layer — the shared DOWNWARD home every consumer already
 * depends on — so the single copy of the read/dedup contract lives in one place,
 * and no layer imports another (§5.1: grading never imports prediction).
 *
 * These host the grouped-by-ocid shape ONLY. The shipped `lifecycle/project.ts`
 * (flat array feeding `reconstructMany`) and `normalise/project.ts` (tender-
 * filtered) read the same store into DIFFERENT shapes and deliberately stay apart.
 */
import { readAcceptedReleases, readPageBody } from '../store/raw-store.js';
import type { AcceptedRelease } from '../store/raw-store.js';
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

/**
 * The single copy of the read/cache/find/fail-loud/dedup spine: read the
 * accepted-release projection, cache each page body by its content hash, find
 * each release by id (fail loud on a miss — the projection points at a body that
 * MUST contain it), and dedup by release id. Both public readers below iterate
 * this and apply their own terminal (event lift vs raw release) and group key
 * (`ev.ocid` vs `rec.ocid`) — so the shared, lockstep-changing part lives once.
 */
function* dedupedReleases(rootDir: string): Iterable<{ rec: AcceptedRelease; release: unknown }> {
  const accepted = readAcceptedReleases(rootDir);
  const pageCache = new Map<string, PackagePage>();
  const seenIds = new Set<string>();

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
    yield { rec, release };
  }
}

/** Build per-ocid event streams from the raw store, deduped by release id. */
export function readEventsByOcid(rootDir: string): Map<string, LifecycleEvent[]> {
  const byOcid = new Map<string, LifecycleEvent[]>();
  for (const { release } of dedupedReleases(rootDir)) {
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

/**
 * Build per-ocid RAW release bodies from the raw store, deduped by release id —
 * the same read/dedup spine as `readEventsByOcid` (now shared via
 * `dedupedReleases`) and `identity/project.ts`, but yielding the untouched
 * release objects (which the model predictor's identity join needs) rather than
 * lifted events, grouped by the store's authoritative ocid.
 */
export function readReleasesByOcid(rootDir: string): Map<string, unknown[]> {
  const byOcid = new Map<string, unknown[]>();
  for (const { rec, release } of dedupedReleases(rootDir)) {
    let group = byOcid.get(rec.ocid);
    if (group === undefined) {
      group = [];
      byOcid.set(rec.ocid, group);
    }
    group.push(release);
  }
  return byOcid;
}
