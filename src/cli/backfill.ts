/**
 * Live backfill CLI thin shell (brief req 8): argument parsing plus wiring the
 * shared live transport and sleep (from `live-deps.ts`) into the identical
 * `runBackfill` path the contract tests exercise. Like `fetch-day.ts`, this is
 * a shell only — all the ingest/checkpoint logic lives in `runBackfill`.
 *
 * Politeness (invariant #3): ≥13 s between requests, carried ACROSS day
 * boundaries by the store's journal floor, Retry-After honoured. A three-day
 * catch-up is ~16 requests, so a live run takes a few minutes.
 */
import { parseArgs } from 'node:util';
import { runBackfill, BackfillError, type BackfillSummary } from '../ingest/backfill.js';
import { londonDayRange } from '../ingest/window.js';
import { createRawStore } from '../store/raw-store.js';
import { USER_AGENT, liveTransport, sleep } from './live-deps.js';

const USAGE = `Usage: node dist/cli/backfill.js --from YYYY-MM-DD --to YYYY-MM-DD [--store DIR]

Back-fill a contiguous range of Europe/London days of the FTS whole-stream
release feed into the raw append-only store, oldest-first and resumably: an
interrupted re-run over the same range skips days already marked complete and
ingests only the remainder.

Options:
  --from YYYY-MM-DD  first London day of the range (inclusive)
  --to   YYYY-MM-DD  last London day of the range (inclusive)
  --store DIR        store root directory (default: data)
  -h, --help         show this help

The range is INCLUSIVE of both endpoints. Requests are paced >=13 s apart
(across day boundaries too) and Retry-After is honoured; a three-day range is
~16 requests, so expect a few minutes.`;

function printDayLines(summary: BackfillSummary): void {
  for (const day of summary.days) {
    if (day.skipped || day.summary === null) {
      console.log(`  ${day.day}: skipped (already complete)`);
    } else {
      const s = day.summary;
      console.log(
        `  ${day.day}: accepted ${s.accepted}, seen ${s.seen}, ` +
          `already present ${s.alreadyPresent}, quarantined ${s.quarantined}`,
      );
    }
  }
  console.log(
    `Totals: ${summary.ingestedDays} day(s) ingested, ${summary.skippedDays} skipped — ` +
      `accepted ${summary.accepted}, seen ${summary.seen}, ` +
      `already present ${summary.alreadyPresent}, quarantined ${summary.quarantined}`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      store: { type: 'string', default: 'data' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.from === undefined || values.to === undefined) {
    console.error('Both --from and --to are required.\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // Validate the range before announcing the work, so an invalid range prints
  // the error alone, not an optimistic "Backfilling …" line first (D1).
  // runBackfill re-derives the same pure range internally.
  londonDayRange(values.from, values.to);

  console.log(
    `Backfilling ${values.from}..${values.to} (inclusive, Europe/London) into ${values.store}/`,
  );

  const summary = await runBackfill(
    {
      transport: liveTransport,
      sleep,
      now: Date.now,
      store: createRawStore(values.store),
      requestHeaders: { 'user-agent': USER_AGENT },
    },
    { from: values.from, to: values.to },
  );

  printDayLines(summary);
}

main().catch((error: unknown) => {
  if (error instanceof BackfillError) {
    // A day aborted after beginRun: prior days stay marked complete, a terminal
    // run-end {ok:false} is journaled for the failing day. Print the partial
    // progress alongside the error so the operator can resume (C-M2 / req 3).
    console.error(`Backfill failed: ${error.message}`);
    printDayLines(error.summary);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
