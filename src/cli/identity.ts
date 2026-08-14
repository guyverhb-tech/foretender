/**
 * Offline identity-projection CLI thin shell (slice 6): argument parsing plus a
 * call to `projectIdentities` over an existing store. It touches NO network and
 * imports no transport or clock — the projection is pure disk I/O over the raw
 * store an earlier fetch/backfill run produced.
 *
 * Like `cli/lifecycle.ts`, this is a shell only: all the resolution logic lives
 * in `projectIdentities`, which the contract tests exercise directly.
 */
import { parseArgs } from 'node:util';
import { projectIdentities } from '../identity/project.js';
import type { IdentitySummary } from '../identity/model.js';

const USAGE = `Usage: node dist/cli/identity.js [--store DIR]

Resolve every ocid in an existing raw store to its human identity (title, buyer,
value) across ALL release types, rebuilding <store>/identities.ndjson and printing
a summary (ocid count + per-field presence rates). Offline: reads only existing
raw data, makes no network requests.

Options:
  --store DIR   store root directory (default: data)
  -h, --help    show this help`;

function printSummary(store: string, s: IdentitySummary): void {
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  console.log(`Resolved ${s.ocids} identity(ies) from ${store}/`);
  console.log(
    `  presence: title ${s.title} (${pct(s.rate.title)}), buyer ${s.buyer} (${pct(s.rate.buyer)}), ` +
      `gross ${s.gross} (${pct(s.rate.gross)}), net ${s.net} (${pct(s.rate.net)}), ` +
      `currency ${s.currency} (${pct(s.rate.currency)})`,
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
  printSummary(values.store, projectIdentities(values.store));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
