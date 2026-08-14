/**
 * Offline scoreboard CLI thin shell (plan slice-5 step 8): argument parsing plus
 * the composition of the two projections over an existing store. It touches NO
 * network and imports no transport or clock — both projections are pure disk I/O
 * over the raw store an earlier fetch/backfill run produced. As the composition
 * ROOT it is the one place allowed to drive both layers.
 *
 * Like `cli/lifecycle.ts`, this is a shell only: the prediction/grading logic
 * lives in `projectPredictions`/`gradePredictions`, which the contract tests
 * exercise directly. `--asof` is required and MUST carry an explicit offset (Z or
 * ±HH:MM); the bare 19-char local form is rejected because its epoch would depend
 * on the runner's timezone.
 */
import { parseArgs } from 'node:util';
import { requireOffsetIso } from '../lifecycle/date.js';
import { projectPredictions } from '../prediction/project.js';
import { gradePredictions } from '../grading/project.js';
import type { Scoreboard, SegmentStats } from '../grading/model.js';

const USAGE = `Usage: node dist/cli/scoreboard.js --asof DATE [--store DIR]

Record a pipeline-to-tender prediction for every procurement that is pipeline as
of its own first planning-notice date, grade each against the subsequent stored
notices, and rebuild <store>/predictions.ndjson, <store>/verdicts.ndjson and
<store>/scoreboard.json, printing the per-segment scoreboard (Brier + hit rate +
counts). Offline: reads only existing raw data, makes no network requests.

Options:
  --asof DATE   as-of timestamp; REQUIRED and MUST carry an explicit offset
                (Z or ±HH:MM, e.g. 2026-09-01T00:00:00Z) — a bare local
                datetime is rejected because its epoch depends on the timezone
  --store DIR   store root directory (default: data)
  -h, --help    show this help`;

function printStats(label: string, s: SegmentStats): void {
  console.log(
    `  ${label.padEnd(7)} predictions ${s.predictions}, resolved ${s.resolved} ` +
      `(converted ${s.converted}, not_converted ${s.not_converted}), pending ${s.pending}, ` +
      `hitRate ${s.hitRate.toFixed(4)}, brier ${s.brier.toFixed(4)}`,
  );
}

function printScoreboard(store: string, sb: Scoreboard): void {
  console.log(`Scoreboard over ${store}/ (asof ${sb.gradedAt}, ${sb.graderVersion}):`);
  printStats('UK1', sb.segments.UK1);
  printStats('UK2', sb.segments.UK2);
  printStats('UK3', sb.segments.UK3);
  printStats('None', sb.segments.None);
  printStats('overall', sb.overall);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      store: { type: 'string', default: 'data' },
      asof: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.asof === undefined) {
    throw new Error(
      '--asof is required (an ISO-8601 timestamp carrying an explicit offset, e.g. 2026-09-01T00:00:00Z)',
    );
  }
  const asof = requireOffsetIso(values.asof, '--asof');
  projectPredictions(values.store, { asof });
  printScoreboard(values.store, gradePredictions(values.store, { asof }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
