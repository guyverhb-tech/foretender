/**
 * Offline lifecycle-projection CLI thin shell (plan step 5): argument parsing
 * plus a call to `projectLifecycles` over an existing store. It touches NO
 * network and imports no transport or clock — the projection is pure disk I/O
 * over the raw store an earlier fetch/backfill run produced.
 *
 * Like `cli/normalise.ts`, this is a shell only: all the reconstruction logic
 * lives in `projectLifecycles`, which the contract tests exercise directly.
 */
import { parseArgs } from 'node:util';
import { projectLifecycles } from '../lifecycle/project.js';
import type { LifecycleSummary } from '../lifecycle/model.js';

const USAGE = `Usage: node dist/cli/lifecycle.js [--store DIR]

Reconstruct every ocid's lifecycle from the releases in an existing raw store,
rebuilding <store>/lifecycles.ndjson and <store>/lifecycle-anomalies.ndjson and
printing a summary (state distribution, anomaly count + rate, orphan/skipped
counts, regime split). Offline: reads only existing raw data, makes no network
requests.

Options:
  --store DIR   store root directory (default: data)
  -h, --help    show this help`;

function printSummary(store: string, s: LifecycleSummary): void {
  const d = s.stateDistribution;
  const pct = (rate: number): string => `${(rate * 100).toFixed(2)}%`;
  console.log(`Reconstructed ${s.ocids} lifecycle(s) over ${s.events} event(s) from ${store}/`);
  console.log(
    `  state: pipeline ${d.pipeline}, tender ${d.tender}, awarded ${d.awarded}, ` +
      `cancelled ${d.cancelled}, terminated ${d.terminated}, unknown ${d.unknown}`,
  );
  console.log(`  regime: UKPGA ${s.regime.UKPGA}, CELEX ${s.regime.CELEX}`);
  console.log(
    `  anomalies ${s.anomalyEvents} over ${s.anomalousOcids} ocid(s) (rate ${pct(s.anomalyRate)})`,
  );
  console.log(`  orphanBase ${s.orphanBaseOcids}, skippedStages ${s.skippedOcids}`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      store: { type: 'string', default: 'data' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  printSummary(values.store, projectLifecycles(values.store));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
