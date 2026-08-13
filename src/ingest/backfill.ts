/**
 * Resumable multi-day backfill (brief reqs 1, 3, 4, 5, 6). A backfill is a loop
 * that calls the existing `ingestWindow` once per London day, oldest-first,
 * gated by the store's persisted day-completion checkpoint. Everything hard —
 * cross-run pacing, idempotent dedupe against the frozen snapshot, raw
 * persistence, replay — is already owned by `ingestWindow` and the store; this
 * module adds no parallel copy of any of it.
 *
 * The same `deps` (one transport, one sleep, one clock, one store) is reused
 * across all days, so cross-day politeness (≥13 s between ANY two requests,
 * invariant #3) falls straight out of `ingestWindow`'s first-request pacing off
 * the store's journal floor (`lastRequestEpochMs`) — there is no backfill-level
 * spacing code.
 */
import { ingestWindow, type IngestDeps } from './ingest.js';
import { londonDayRange } from './window.js';
import type { RunSummary, RunWindow } from '../store/raw-store.js';

export interface DayResult {
  day: string;
  window: RunWindow;
  /** True when the day was already complete and no request was made. */
  skipped: boolean;
  /** The resolved run summary for an ingested day; null for a skipped day. */
  summary: RunSummary | null;
}

export interface BackfillSummary {
  /** One entry per day in the range, in `londonDayRange` order (oldest-first). */
  days: DayResult[];
  ingestedDays: number;
  skippedDays: number;
  /** Totals over the ingested days only (skipped days contribute nothing). */
  seen: number;
  accepted: number;
  alreadyPresent: number;
  quarantined: number;
}

/**
 * Thrown when a day's `ingestWindow` aborts. Carries the progress-so-far
 * `BackfillSummary`, mirroring `IngestError`. Prior days already marked
 * complete stay complete — that is the crash-and-resume seam.
 */
export class BackfillError extends Error {
  readonly summary: BackfillSummary;
  constructor(message: string, summary: BackfillSummary) {
    super(message);
    this.name = 'BackfillError';
    this.summary = summary;
  }
}

/**
 * Back-fill the inclusive London-day range `[from, to]` into the store,
 * oldest-first. Reads the completed-day set once, then for each day: skips it
 * if already complete, else ingests its whole-day window and — only on the
 * resolve a normal `links`-absent termination produces — marks it complete. On
 * a day's abort, throws `BackfillError` with the progress so far.
 */
export async function runBackfill(
  deps: IngestDeps,
  opts: { from: string; to: string },
): Promise<BackfillSummary> {
  const range = londonDayRange(opts.from, opts.to);
  // Read once up front: this is the resume authority. A day that finished in a
  // prior run is skipped without a request.
  const completed = deps.store.completedDays();

  const days: DayResult[] = [];
  let ingestedDays = 0;
  let skippedDays = 0;
  let seen = 0;
  let accepted = 0;
  let alreadyPresent = 0;
  let quarantined = 0;

  const summarise = (): BackfillSummary => ({
    days,
    ingestedDays,
    skippedDays,
    seen,
    accepted,
    alreadyPresent,
    quarantined,
  });

  for (const { day, updatedFrom, updatedTo } of range) {
    const window: RunWindow = { updatedFrom, updatedTo };

    if (completed.has(day)) {
      skippedDays += 1;
      days.push({ day, window, skipped: true, summary: null });
      continue;
    }

    let summary: RunSummary;
    try {
      // No `limit`/`minSpacingMs` overrides: defaults (100 / 13 000 ms) match
      // the fixtures and invariant #3.
      summary = await ingestWindow(deps, { updatedFrom, updatedTo });
    } catch (error) {
      // A day aborted (transport/store/sleep rejection, surfaced as
      // IngestError after beginRun). Prior days remain marked complete; this
      // day is not — an incomplete day is re-run in full on resume.
      const message = error instanceof Error ? error.message : String(error);
      throw new BackfillError(`backfill aborted on ${day}: ${message}`, summarise());
    }

    // Mark complete only on normal completion. Run-independent write (the run
    // is already ended); keyed on `day`, no runId.
    deps.store.markDayComplete(day, {
      window,
      accepted: summary.accepted,
      seen: summary.seen,
      alreadyPresent: summary.alreadyPresent,
      quarantined: summary.quarantined,
    });

    ingestedDays += 1;
    seen += summary.seen;
    accepted += summary.accepted;
    alreadyPresent += summary.alreadyPresent;
    quarantined += summary.quarantined;
    days.push({ day, window, skipped: false, summary });
  }

  return summarise();
}
