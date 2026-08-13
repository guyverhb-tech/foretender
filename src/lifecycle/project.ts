/**
 * The lifecycle projection over an existing raw store (brief reqs 5–6; §5.3;
 * plan step 4). Offline and pure disk I/O: it reads the append-only store, builds
 * a `LifecycleEvent` for EVERY accepted release (all tags, not just tenders),
 * reconstructs one lifecycle per ocid, and rebuilds two DERIVED sibling files —
 * `lifecycles.ndjson` and `lifecycle-anomalies.ndjson` — plus a `LifecycleSummary`.
 *
 * Like `normalise/project.ts` this is a deterministic FULL REBUILD (truncate-
 * then-write in ocid-sorted order with fixed key order), sanctioned for §5.3
 * replay: two runs over the same raw store produce byte-identical output. The raw
 * store stays append-only; only these derived views are rebuilt. A partial file
 * on interrupt is acceptable — the next run rebuilds it wholesale.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAcceptedReleases, readPageBody } from '../store/raw-store.js';
import { toLifecycleEvent } from './event.js';
import { reconstructMany } from './machine.js';
import type { LifecycleEvent, LifecycleState, LifecycleSummary } from './model.js';

interface PackagePage {
  releases?: unknown[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** NDJSON: one record per line, trailing newline; an empty list yields an empty file. */
const toNdjson = (records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

/** State distribution seeded with every state at 0, so the shape is stable. */
const emptyStateDistribution = (): Record<LifecycleState, number> => ({
  pipeline: 0,
  tender: 0,
  awarded: 0,
  cancelled: 0,
  terminated: 0,
  unknown: 0,
});

export function projectLifecycles(rootDir: string): LifecycleSummary {
  const accepted = readAcceptedReleases(rootDir);
  const pageCache = new Map<string, PackagePage>();
  const seenIds = new Set<string>();
  const events: LifecycleEvent[] = [];

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
    // backfill window overlap even though ingest already deduped on the frozen snapshot.
    if (seenIds.has(rec.id)) continue;
    seenIds.add(rec.id);
    events.push(toLifecycleEvent(release));
  }

  const lifecycles = reconstructMany(events);
  // Lifecycles are ocid-ascending and each lifecycle's anomalies are in fold
  // (notice-id-ascending) order, so a flat map is ocid-asc then notice-id-asc.
  const flatAnomalies = lifecycles.flatMap((l) => l.anomalies);

  writeFileSync(join(rootDir, 'lifecycles.ndjson'), toNdjson(lifecycles));
  writeFileSync(join(rootDir, 'lifecycle-anomalies.ndjson'), toNdjson(flatAnomalies));

  const stateDistribution = emptyStateDistribution();
  const regime = { UKPGA: 0, CELEX: 0 };
  let anomalousOcids = 0;
  let orphanBaseOcids = 0;
  let skippedOcids = 0;
  for (const lc of lifecycles) {
    stateDistribution[lc.state]++;
    if (lc.regime === 'UKPGA') regime.UKPGA++;
    else if (lc.regime === 'CELEX') regime.CELEX++;
    if (lc.anomalies.length > 0) anomalousOcids++;
    if (lc.orphanBase) orphanBaseOcids++;
    if (lc.skippedStages) skippedOcids++;
  }

  return {
    ocids: lifecycles.length,
    events: events.length,
    stateDistribution,
    anomalyEvents: flatAnomalies.length,
    anomalousOcids,
    anomalyRate: events.length === 0 ? 0 : flatAnomalies.length / events.length,
    orphanBaseOcids,
    skippedOcids,
    regime,
  };
}
