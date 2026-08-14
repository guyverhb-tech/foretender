/**
 * The prediction projection over an existing raw store (brief req 6; §5.3; plan
 * slice-5 step 4). Offline, pure disk I/O: it reads the append-only store, builds
 * a `LifecycleEvent` for every accepted release, groups by ocid, runs the pure
 * `predict` over each group, and rebuilds one DERIVED sibling — `predictions.ndjson`.
 *
 * Like `lifecycle/project.ts` this is a deterministic FULL REBUILD (truncate-then-
 * write in ocid-sorted order with fixed key order), a rebuildable VIEW of
 * `(store + priors + asof)` — NOT an append-only ledger. The append-only guarantee
 * lives in the raw store it rebuilds from; two runs over the same store and
 * `--asof` are byte-identical by construction. `--asof` is validated offset-explicit
 * at entry so the output is TZ-independent.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEventsByOcid, toNdjson } from '../lifecycle/read.js';
import { requireOffsetIso } from '../lifecycle/date.js';
import { segmentOf } from '../lifecycle/segment.js';
import type { Segment } from '../lifecycle/segment.js';
import { predict } from './predict.js';
import type { PredictOpts, Prediction, PredictionSummary } from './model.js';

export function projectPredictions(rootDir: string, opts: PredictOpts): PredictionSummary {
  requireOffsetIso(opts.asof, '--asof');

  const byOcid = readEventsByOcid(rootDir);

  // Walk ocids ascending so the file is ocid-sorted and byte-reproducible.
  const predictions: Prediction[] = [];
  for (const ocid of [...byOcid.keys()].sort()) {
    const p = predict(byOcid.get(ocid) ?? [], opts);
    if (p !== null) predictions.push(p);
  }

  writeFileSync(join(rootDir, 'predictions.ndjson'), toNdjson(predictions));

  const bySegment: Record<Segment, number> = { UK1: 0, UK2: 0, UK3: 0, None: 0 };
  for (const p of predictions) bySegment[segmentOf(p.noticeType)]++;
  return { predictions: predictions.length, bySegment };
}
