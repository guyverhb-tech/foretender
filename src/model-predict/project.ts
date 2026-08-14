/**
 * The model-prediction projection over an existing raw store (slice 7). Offline
 * disk I/O plus the injected model client. For every candidate ocid it writes
 * BOTH a baseline row (from `predict`) and a model row (from `predictWithModel`)
 * into the SHARED `predictions.ndjson`, keyed apart by `predictorVersion` — a
 * deterministic FULL REBUILD sorted by `(ocid, predictorVersion)`, so two runs
 * over the same store and `--asof` are byte-identical (honesty is the date
 * cutoff, not append-only storage).
 *
 * It also RETURNS the `Prediction[]` it wrote, so the composition-root CLI
 * can partition those rows by `predictorVersion` and grade each with the
 * UNMODIFIED pure grader — the fair head-to-head — without a second disk reader
 * and without touching the grading layer.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEventsByOcid, readReleasesByOcid, toNdjson } from '../lifecycle/read.js';
import { requireOffsetIso } from '../lifecycle/date.js';
import { predict } from '../prediction/predict.js';
import type { PredictOpts, Prediction } from '../prediction/model.js';
import { predictWithModel } from './predict.js';
import type { ModelClient } from './client.js';

/** The projection's result: the written rows plus inspectable counts. */
export interface ModelProjectionResult {
  predictions: Prediction[];
  /** Ocids that produced a baseline prediction (and therefore a model call). */
  candidates: number;
  baseline: number;
  model: number;
}

export async function projectModelPredictions(
  rootDir: string,
  opts: PredictOpts,
  client: ModelClient,
): Promise<ModelProjectionResult> {
  requireOffsetIso(opts.asof, '--asof');

  const eventsByOcid = readEventsByOcid(rootDir);
  const releasesByOcid = readReleasesByOcid(rootDir);

  const rows: Prediction[] = [];
  let candidates = 0;
  let baseline = 0;
  let model = 0;
  // Walk ocids ascending; the final rebuild is re-sorted so order is stable.
  for (const ocid of [...eventsByOcid.keys()].sort()) {
    const events = eventsByOcid.get(ocid) ?? [];
    const base = predict(events, opts);
    if (base === null) continue;
    candidates += 1;
    rows.push(base);
    baseline += 1;
    const modelRow = await predictWithModel(events, releasesByOcid.get(ocid) ?? [], opts, client);
    if (modelRow !== null) {
      rows.push(modelRow);
      model += 1;
    }
  }

  // Deterministic full rebuild: (ocid, predictorVersion) ascending.
  rows.sort((a, b) =>
    a.ocid < b.ocid
      ? -1
      : a.ocid > b.ocid
        ? 1
        : a.predictorVersion < b.predictorVersion
          ? -1
          : a.predictorVersion > b.predictorVersion
            ? 1
            : 0,
  );

  writeFileSync(join(rootDir, 'predictions.ndjson'), toNdjson(rows));
  return { predictions: rows, candidates, baseline, model };
}
