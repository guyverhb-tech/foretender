/**
 * The model-predictor CLI (slice 7). A thin composition root over the model
 * projection and the UNMODIFIED slice-5
 * grader/calibrator — the one place allowed to drive both layers.
 *
 * Default path: replay-only from the recorded model-call ledger under
 * `<store>/model-calls/` — ZERO network. A cache miss fails loud (re-run with
 * `--live` to record). `--live` opts in to real API calls behind a per-run budget
 * cap and an env-only key (read up front, so a missing key fails before any work).
 *
 * The fair head-to-head: `projectModelPredictions` returns the rows it wrote;
 * this CLI partitions THEM in memory by `predictorVersion` and grades each
 * partition separately, writing `scoreboard-by-predictor.json`. The slice-5
 * `scoreboard.json` is NOT the head-to-head: its `scoreboard.js` CLI full-rebuilds
 * `predictions.ndjson` to baseline-only before grading, so it never reflects model
 * rows (a blend needs a direct `gradePredictions()` call on a model-populated
 * file) — said so in the output below.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireOffsetIso } from '../lifecycle/date.js';
import { readEventsByOcid } from '../lifecycle/read.js';
import { grade } from '../grading/grade.js';
import { calibrate } from '../grading/calibrate.js';
import { GRADER_VERSION } from '../grading/model.js';
import type { Scoreboard, SegmentStats, Verdict } from '../grading/model.js';
import type { LifecycleEvent } from '../lifecycle/model.js';
import type { Prediction } from '../prediction/model.js';
import { projectModelPredictions } from '../model-predict/project.js';
import { createLedgerClient } from '../model-predict/ledger.js';
import { MODEL_PREDICTOR_VERSION } from '../model-predict/predict.js';
import { PROMPT_VERSION } from '../model-predict/prompt.js';
import type { ModelClient } from '../model-predict/client.js';
import { liveModelClient } from './live-model.js';

const DEFAULT_BUDGET = 200;

const USAGE = `Usage: node dist/cli/model-predict.js --asof DATE [--store DIR] [--live] [--budget N]

Record a MODEL prediction (the first agent) for every procurement the baseline
predicts, alongside the baseline row in the shared <store>/predictions.ndjson
(keyed by predictorVersion). Grade each predictor separately with the unmodified
slice-5 grader and write <store>/scoreboard-by-predictor.json — the fair
model-vs-baseline head-to-head.

By default the model client is REPLAY-ONLY over <store>/model-calls/ and makes no
network requests; a cache miss fails loud. --live opts in to real Anthropic calls
behind a budget cap, recording each verbatim to the ledger.

Options:
  --asof DATE    as-of timestamp; REQUIRED and MUST carry an explicit offset
                 (Z or ±HH:MM, e.g. 2026-09-01T00:00:00Z)
  --store DIR    store root directory (default: data)
  --live         make real Anthropic API calls (needs the API key from .env.example); off by default
  --budget N     max live calls per run (default: ${DEFAULT_BUDGET}); ignored without --live
  -h, --help     show this help`;

/**
 * Grade one predictorVersion partition with the UNMODIFIED pure grader.
 * `Prediction` is a structural superset of the grader's `PredictionRecord`, so
 * `grade` accepts each row directly — this in-memory path never crosses the file
 * boundary where the narrowing would matter (the §5.1 field-name seam lives in
 * `PredictionRecord`'s definition and `readPredictionRecords`, untouched here).
 */
function gradePartition(
  rows: Prediction[],
  eventsByOcid: Map<string, LifecycleEvent[]>,
  asof: string,
): Verdict[] {
  return rows.map((p) => grade(p, eventsByOcid.get(p.ocid) ?? [], { asof }));
}

function printStats(label: string, s: SegmentStats): void {
  console.log(
    `    ${label.padEnd(7)} predictions ${s.predictions}, resolved ${s.resolved} ` +
      `(converted ${s.converted}, not_converted ${s.not_converted}), pending ${s.pending}, ` +
      `hitRate ${s.hitRate.toFixed(4)}, brier ${s.brier.toFixed(4)}`,
  );
}

function printScoreboard(version: string, sb: Scoreboard): void {
  console.log(`  ${version}:`);
  printStats('UK1', sb.segments.UK1);
  printStats('UK2', sb.segments.UK2);
  printStats('UK3', sb.segments.UK3);
  printStats('None', sb.segments.None);
  printStats('overall', sb.overall);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      store: { type: 'string', default: 'data' },
      asof: { type: 'string' },
      live: { type: 'boolean', default: false },
      budget: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const store = values.store ?? 'data';
  const ledgerDir = join(store, 'model-calls');

  // Build the client first. --live reads the key here (throwing loud if absent),
  // so `--live` with no key fails on the key before any other argument is checked.
  let client: ModelClient;
  if (values.live) {
    const budget = values.budget !== undefined ? Number(values.budget) : DEFAULT_BUDGET;
    if (!Number.isInteger(budget) || budget < 0) {
      throw new Error(`--budget must be a non-negative integer, got «${values.budget}»`);
    }
    client = createLedgerClient({
      inner: liveModelClient(),
      dir: ledgerDir,
      now: Date.now,
      predictorVersion: MODEL_PREDICTOR_VERSION,
      promptVersion: PROMPT_VERSION,
      maxLiveCalls: budget,
    });
  } else {
    // Replay-only: an inner that fails loud on a miss (no cap, so the message is
    // this one, not a budget error). The whole default path is zero-network.
    const replayOnly: ModelClient = async () => {
      throw new Error(
        'model-predict: no recorded model call for this request; re-run with --live ' +
          '(with the API key set — see .env.example) to record it',
      );
    };
    client = createLedgerClient({
      inner: replayOnly,
      dir: ledgerDir,
      now: Date.now,
      predictorVersion: MODEL_PREDICTOR_VERSION,
      promptVersion: PROMPT_VERSION,
    });
  }

  if (values.asof === undefined) {
    throw new Error(
      '--asof is required (an ISO-8601 timestamp carrying an explicit offset, e.g. 2026-09-01T00:00:00Z)',
    );
  }
  const asof = requireOffsetIso(values.asof, '--asof');

  const { predictions } = await projectModelPredictions(store, { asof }, client);

  // Partition the returned rows by predictorVersion; grade each separately.
  const eventsByOcid = readEventsByOcid(store);
  const versions = [...new Set(predictions.map((p) => p.predictorVersion))].sort();
  const byPredictor: Record<string, Scoreboard> = {};
  for (const version of versions) {
    const rows = predictions.filter((p) => p.predictorVersion === version);
    byPredictor[version] = calibrate(gradePartition(rows, eventsByOcid, asof));
  }
  const out = { asof, graderVersion: GRADER_VERSION, byPredictor };
  writeFileSync(join(store, 'scoreboard-by-predictor.json'), `${JSON.stringify(out, null, 2)}\n`);

  console.log(`Model-vs-baseline scoreboard over ${store}/ (asof ${asof}):`);
  for (const [version, sb] of Object.entries(byPredictor)) printScoreboard(version, sb);
  console.log('');
  console.log(
    'scoreboard-by-predictor.json is the fair head-to-head — each predictorVersion graded separately.',
  );
  console.log(
    'NOTE: the slice-5 scoreboard.js CLI always full-rebuilds predictions.ndjson to ' +
      'baseline-only before grading, so its scoreboard.json never reflects model rows; a ' +
      'blend of both predictors only happens on a direct gradePredictions() call on a ' +
      'model-populated file (library/test use). Either way scoreboard.json is NOT the head-to-head.',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
