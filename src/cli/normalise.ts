/**
 * Offline tender-normalisation CLI thin shell (brief req 8; plan step 5):
 * argument parsing plus a call to `projectTenders` over an existing store. It
 * touches NO network and imports no transport or clock — the projection is pure
 * disk I/O over the raw store an earlier fetch/backfill run produced.
 *
 * Like `backfill.ts`, this is a shell only: all the normalisation logic lives in
 * `projectTenders`, which the contract tests exercise directly.
 */
import { parseArgs } from 'node:util';
import { projectTenders, type ProjectionSummary } from '../normalise/project.js';

const USAGE = `Usage: node dist/cli/normalise.js [--store DIR]

Project the tender-tagged releases in an existing raw store into a deterministic
canonical model, rebuilding <store>/canonical.ndjson and <store>/anomalies.ndjson
and printing a summary (regime split, anomaly count + rate, per-regime field
coverage). Offline: reads only existing raw data, makes no network requests.

Options:
  --store DIR   store root directory (default: data)
  -h, --help    show this help`;

function printSummary(store: string, s: ProjectionSummary): void {
  const uk = s.fieldCoverage.ukpga;
  const ce = s.fieldCoverage.celex;
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  console.log(`Projected ${s.tenderReleases} tender release(s) from ${store}/`);
  console.log(`  regime: UKPGA ${s.regime.UKPGA}, CELEX ${s.regime.CELEX}`);
  console.log(`  canonical ${s.canonical}, anomalies ${s.anomalies} (rate ${pct(s.anomalyRate)})`);
  console.log(
    `  UKPGA coverage (n=${uk.n}): amountGross ${uk.amountGross}, coreAmount ${uk.coreAmount}, ` +
      `cpv ${uk.cpv}, lotContractPeriod ${uk.lotContractPeriod}, deadline ${uk.deadline}, ` +
      `mainProcurementCategory ${uk.mainProcurementCategory}, hasRenewalTrue ${uk.hasRenewalTrue}`,
  );
  console.log(
    `  CELEX coverage (n=${ce.n}): amount ${ce.amount}, cpv ${ce.cpv}, ` +
      `lotDurationInDays ${ce.lotDurationInDays}, lotEndDate ${ce.lotEndDate}, ` +
      `tenderPeriodEnd ${ce.tenderPeriodEnd}, mainProcurementCategory ${ce.mainProcurementCategory}`,
  );
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
  printSummary(values.store, projectTenders(values.store));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
