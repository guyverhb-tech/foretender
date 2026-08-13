/**
 * Deterministic test instruments: virtual clock, virtual sleep, and readers
 * for the store's pinned on-disk layout (plan §Interface changes):
 *
 *   <root>/raw/journal.ndjson
 *   <root>/raw/pages/<sha256>
 *   <root>/releases.ndjson
 *   <root>/quarantine.ndjson
 *
 * The clock advances ONLY via sleep (or explicit advance) — no wall time
 * anywhere. Every value the clock ever returned is recorded so tests can
 * assert journal timestamps are faithful to the injected clock, not merely
 * present (critique M1′ / binding addendum M1).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VirtualClock {
  now: () => number;
  advance: (ms: number) => void;
  /** Every value now() has returned, in call order. */
  returned: number[];
}

export function makeVirtualClock(startMs: number): VirtualClock {
  let t = startMs;
  const returned: number[] = [];
  return {
    now: () => {
      returned.push(t);
      return t;
    },
    advance: (ms: number) => {
      t += ms;
    },
    returned,
  };
}

export interface VirtualSleep {
  sleep: (ms: number) => Promise<void>;
  /** Every duration requested, in call order. */
  requested: number[];
}

/** Records requested durations and advances the clock instead of waiting. */
export function makeVirtualSleep(clock: VirtualClock): VirtualSleep {
  const requested: number[] = [];
  return {
    sleep: async (ms: number) => {
      requested.push(ms);
      clock.advance(ms);
    },
    requested,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** ISO-8601 with offset (Z or ±HH:MM), seconds mandatory. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type NdjsonRecord = Record<string, any>;

export function readNdjson(path: string): NdjsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as NdjsonRecord);
}

export const journalPath = (root: string): string => join(root, 'raw', 'journal.ndjson');
export const pagesDir = (root: string): string => join(root, 'raw', 'pages');
export const releasesPath = (root: string): string => join(root, 'releases.ndjson');
export const quarantinePath = (root: string): string => join(root, 'quarantine.ndjson');
export const checkpointsPath = (root: string): string => join(root, 'checkpoints.ndjson');

export const readJournal = (root: string): NdjsonRecord[] => readNdjson(journalPath(root));
export const httpRecords = (root: string): NdjsonRecord[] =>
  readJournal(root).filter((r) => r['kind'] === 'http');
export const readReleases = (root: string): NdjsonRecord[] => readNdjson(releasesPath(root));
export const readQuarantine = (root: string): NdjsonRecord[] => readNdjson(quarantinePath(root));
export const readCheckpoints = (root: string): NdjsonRecord[] => readNdjson(checkpointsPath(root));

/**
 * Drop the run-scoped fields for §5.3 replay comparison (plan step 5): a
 * replayed run necessarily differs in runId/at/epochMs. Each dropped field is
 * pinned by its own test elsewhere (store contract: presence + clock
 * fidelity + runId stability; ingest contract: spacing between records), so
 * this ignore-list never hides an unpinned field (critique M1′ closed).
 */
export function dropRunScoped(record: NdjsonRecord): NdjsonRecord {
  const { runId: _runId, at: _at, epochMs: _epochMs, ...rest } = record;
  return rest;
}
