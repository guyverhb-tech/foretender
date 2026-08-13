/**
 * Live CLI thin shell (brief req 8): argument parsing plus wiring the shared
 * live transport and sleep (from `live-deps.ts`, the repo's only global-fetch
 * site) into the identical `ingestWindow` path the contract tests exercise.
 *
 * Politeness (invariant #3): ≥13 s between requests, Retry-After honoured —
 * a one-day window is ~4–5 requests, so a run takes ~60–90 s.
 */
import { parseArgs } from 'node:util';
import { ingestWindow, IngestError } from '../ingest/ingest.js';
import { londonDayWindow } from '../ingest/window.js';
import { createRawStore, type RunSummary } from '../store/raw-store.js';
import { USER_AGENT, liveTransport, sleep } from './live-deps.js';

/**
 * Strip C0/C1 control characters before printing store-derived strings (a
 * release `id`/`date`) to the terminal — an `id` carrying a carriage return or
 * an ANSI/OSC escape would otherwise rewrite the operator's terminal or the
 * log they later trust (S-m6). Built from code points so no control byte lives
 * in this source file.
 */
const printable = (value: string): string =>
  [...value]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && !(code >= 0x7f && code <= 0x9f);
    })
    .join('');

const USAGE = `Usage: node dist/cli/fetch-day.js [--day YYYY-MM-DD] [--store DIR]

Fetch one Europe/London day of the FTS whole-stream release feed into the raw
append-only store.

Options:
  --day YYYY-MM-DD  London day to fetch (default: yesterday in Europe/London)
  --store DIR       store root directory (default: data)
  -h, --help        show this help

Requests are paced >=13 s apart and Retry-After is honoured; expect ~60-90 s
for a typical day.`;

function printSummaryLine(prefix: string, summary: RunSummary): void {
  console.log(
    `${prefix}pages ${summary.pages}, seen ${summary.seen}, accepted ${summary.accepted}, ` +
      `already present ${summary.alreadyPresent}, quarantined ${summary.quarantined}` +
      (summary.quarantinedPages ? `, pages quarantined ${summary.quarantinedPages}` : ''),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      day: { type: 'string' },
      store: { type: 'string', default: 'data' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const window = londonDayWindow({ day: values.day });
  console.log(
    `Fetching ${window.day} (Europe/London): ${window.updatedFrom} -> ${window.updatedTo} into ${values.store}/`,
  );

  const summary = await ingestWindow(
    {
      transport: liveTransport,
      sleep,
      now: Date.now,
      store: createRawStore(values.store),
      requestHeaders: { 'user-agent': USER_AGENT },
    },
    { updatedFrom: window.updatedFrom, updatedTo: window.updatedTo },
  );

  printSummaryLine('Done: ', summary);
  if (summary.lastSeenRelease !== null) {
    const { id, date } = summary.lastSeenRelease;
    console.log(`Last seen release: ${printable(id)} (${date !== undefined ? printable(date) : 'no date'})`);
  }
  if (summary.accepted === 0) {
    console.log(`0 new releases — ${summary.alreadyPresent} of ${summary.seen} seen were already present.`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof IngestError) {
    // The run aborted after beginRun: a terminal run-end {ok:false} is already
    // journaled. Print the partial summary alongside the error (C-M2).
    console.error(`Ingest failed: ${error.message}`);
    printSummaryLine('Partial: ', error.summary);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
