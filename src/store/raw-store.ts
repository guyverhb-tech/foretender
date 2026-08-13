/**
 * Raw append-only store (BUILD_BRIEF §5.3): an NDJSON journal of every HTTP
 * exchange plus content-addressed verbatim response bodies, and two derived
 * append-only projections (accepted releases, quarantine).
 *
 * Append-only is by construction: journal/projection writes use the append
 * flag, body files are write-once (`wx`), and no update or delete code path
 * exists. Bodies cross this boundary as bytes and are hashed and written
 * before any caller attempts a decode or parse.
 *
 * Layout under `rootDir`:
 *   raw/journal.ndjson    — one record per run-start / http exchange / run-end
 *   raw/pages/<sha256>    — verbatim body bytes (extensionless; not always JSON)
 *   releases.ndjson       — identity-only projection: id, ocid, bodyHash, runId
 *   quarantine.ndjson     — offending record or bodyHash reference + reason
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The on-disk layout under a store root, named once so product code (the store
 * itself and the replay transport) never re-derives these paths (Q-m4). The
 * test-side readers in `test/helpers/support.ts` keep their own deliberate
 * copies.
 */
export function rawJournalPath(rootDir: string): string {
  return join(rootDir, 'raw', 'journal.ndjson');
}
export function rawPagesDir(rootDir: string): string {
  return join(rootDir, 'raw', 'pages');
}

export interface RunWindow {
  updatedFrom: string;
  updatedTo: string;
}

export interface LastSeenRelease {
  id: string;
  date?: string;
}

/**
 * Resume state per invariant #5 is `window` + `lastSeenRelease` — never the
 * pagination cursor (cursors necessarily appear inside journaled URLs and raw
 * bodies; they must not be read back as state).
 */
export interface RunSummary {
  window: RunWindow;
  pages: number;
  seen: number;
  accepted: number;
  alreadyPresent: number;
  /** Release-level quarantines (identity failure, duplicate-id) are counted in
   * `quarantined`; page-level ones (unparseable-page, off-origin-next) are
   * counted separately in `quarantinedPages` so the release reconciliation
   * `seen == accepted + alreadyPresent + quarantined` holds on every path,
   * including aborts (C-m2). */
  quarantined: number;
  /** Page-level quarantines. Optional so a run-end written by a caller that
   * does not track them (the store contract test's synthetic summaries) stays
   * valid. */
  quarantinedPages?: number;
  lastSeenRelease: LastSeenRelease | null;
  ok: boolean;
}

export interface RunStartMeta {
  limit?: number;
  minSpacingMs?: number;
  ua?: string;
}

export interface ExchangeInput {
  url: string;
  /** Headers as sent, including the user agent. */
  requestHeaders: Record<string, string>;
  status: number;
  /** Lower-case-keyed response headers. */
  responseHeaders: Record<string, string>;
  contentType: string;
  /** Verbatim body bytes — never a decoded string. */
  body: Uint8Array;
}

export interface AcceptedRelease {
  id: string;
  ocid: string;
  bodyHash: string;
}

export interface QuarantineEntry {
  reason: string;
  /**
   * Optional stable identity for cross-run idempotency: one data anomaly
   * yields one quarantine record however many times its window is re-run
   * (C-M4). Entries without a key always append.
   */
  key?: string;
  [context: string]: unknown;
}

export interface RawStore {
  /** Opens a run: creates the layout, loads and FREEZES the accepted-id snapshot. */
  beginRun(window: RunWindow, meta?: RunStartMeta): void;
  /** Persists the body (write-once) and journals the exchange. Call before parsing. */
  recordExchange(exchange: ExchangeInput): { bodyHash: string };
  /**
   * The accepted-id set as of beginRun, frozen for the run — within-run
   * addRelease calls are deliberately NOT visible here. A live set would
   * absorb a within-payload server duplicate as already-present, and
   * quarantine would stop measuring data anomalies (critique N1: "frozen" is
   * load-bearing, not stylistic — do not collapse the two sets).
   */
  snapshotIds(): ReadonlySet<string>;
  addRelease(release: AcceptedRelease): void;
  quarantine(entry: QuarantineEntry): void;
  /**
   * Newest journaled `http`-record `epochMs` across all prior runs — the
   * cross-run pacing floor. Invariant #3 is unqualified (≥13 s between ANY two
   * requests, not merely within one run), so a back-to-back re-run must pace
   * its first request off this. null when the store holds no prior request.
   */
  lastRequestEpochMs(): number | null;
  endRun(summary: RunSummary): void;
}

/** Code version stamped on every journal record as `v`. */
const CODE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

interface ActiveRun {
  runId: string;
  snapshot: Set<string>;
  quarantineKeys: Set<string>;
  seq: number;
}

export function createRawStore(rootDir: string, opts?: { now?: () => number }): RawStore {
  const now = opts?.now ?? Date.now;
  const journalFile = rawJournalPath(rootDir);
  const pagesDir = rawPagesDir(rootDir);
  const releasesFile = join(rootDir, 'releases.ndjson');
  const quarantineFile = join(rootDir, 'quarantine.ndjson');

  let run: ActiveRun | null = null;

  const activeRun = (method: string): ActiveRun => {
    if (run === null) {
      throw new Error(`beginRun must be called before ${method}`);
    }
    return run;
  };

  /** One stamp per record: epochMs from the injected clock, `at` the same instant. */
  const stamp = (): { at: string; epochMs: number } => {
    const epochMs = now();
    return { at: new Date(epochMs).toISOString(), epochMs };
  };

  const appendJournal = (kind: string, runId: string, fields: Record<string, unknown>): void => {
    appendFileSync(journalFile, `${JSON.stringify({ kind, runId, ...stamp(), v: CODE_VERSION, ...fields })}\n`);
  };

  return {
    beginRun(window, meta) {
      mkdirSync(pagesDir, { recursive: true });
      const snapshot = new Set<string>();
      if (existsSync(releasesFile)) {
        for (const line of readFileSync(releasesFile, 'utf8').split('\n')) {
          if (line.trim() === '') continue;
          snapshot.add((JSON.parse(line) as AcceptedRelease).id);
        }
      }
      // Prior quarantine keys, frozen for the run: re-running a window
      // re-quarantines nothing already recorded (C-M4 idempotency).
      const quarantineKeys = new Set<string>();
      if (existsSync(quarantineFile)) {
        for (const line of readFileSync(quarantineFile, 'utf8').split('\n')) {
          if (line.trim() === '') continue;
          const key = (JSON.parse(line) as { key?: unknown }).key;
          if (typeof key === 'string') quarantineKeys.add(key);
        }
      }
      run = { runId: randomUUID(), snapshot, quarantineKeys, seq: 0 };
      appendJournal('run-start', run.runId, { window, ...meta });
    },

    recordExchange(exchange) {
      const current = activeRun('recordExchange');
      const bodyHash = createHash('sha256').update(exchange.body).digest('hex');
      const bodyPath = join(pagesDir, bodyHash);
      // Content-address collision: the bytes are already on disk, so the write
      // is a recognised no-op — the journal line below still records the
      // exchange, which is what "every response persisted raw" means here.
      if (!existsSync(bodyPath)) {
        writeFileSync(bodyPath, exchange.body, { flag: 'wx' });
      }
      current.seq += 1;
      const retryAfter = exchange.responseHeaders['retry-after'];
      appendJournal('http', current.runId, {
        seq: current.seq,
        url: exchange.url,
        requestHeaders: exchange.requestHeaders,
        status: exchange.status,
        responseHeaders: exchange.responseHeaders,
        contentType: exchange.contentType,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        bodyHash,
        bodyBytes: exchange.body.length,
      });
      return { bodyHash };
    },

    snapshotIds() {
      return activeRun('snapshotIds').snapshot;
    },

    addRelease(release) {
      const current = activeRun('addRelease');
      const line = {
        id: release.id,
        ocid: release.ocid,
        bodyHash: release.bodyHash,
        runId: current.runId,
      };
      appendFileSync(releasesFile, `${JSON.stringify(line)}\n`);
    },

    quarantine(entry) {
      const current = activeRun('quarantine');
      // Idempotent by key: one anomaly → one record across re-runs (C-M4).
      if (entry.key !== undefined && current.quarantineKeys.has(entry.key)) return;
      const meta = { runId: current.runId, ...stamp() };
      let line: string;
      try {
        line = JSON.stringify({ ...entry, ...meta });
      } catch {
        // Serialisation must be total (S-m4): a pathological record (e.g. a
        // body nesting `releases` 10 000 deep → RangeError in JSON.stringify)
        // still yields a reference record, so nothing is silently discarded
        // (brief req 6). undefined-valued keys drop out of JSON.stringify.
        line = JSON.stringify({
          reason: entry.reason,
          key: entry.key,
          bodyHash: typeof entry['bodyHash'] === 'string' ? entry['bodyHash'] : undefined,
          note: 'record omitted: unserialisable',
          ...meta,
        });
      }
      appendFileSync(quarantineFile, `${line}\n`);
      if (entry.key !== undefined) current.quarantineKeys.add(entry.key);
    },

    lastRequestEpochMs() {
      if (!existsSync(journalFile)) return null;
      let max: number | null = null;
      for (const rawLine of readFileSync(journalFile, 'utf8').split('\n')) {
        if (rawLine.trim() === '') continue;
        const record = JSON.parse(rawLine) as { kind?: unknown; epochMs?: unknown };
        if (record.kind === 'http' && typeof record.epochMs === 'number') {
          if (max === null || record.epochMs > max) max = record.epochMs;
        }
      }
      return max;
    },

    endRun(summary) {
      const current = activeRun('endRun');
      appendJournal('run-end', current.runId, { ...summary });
      run = null;
    },
  };
}
