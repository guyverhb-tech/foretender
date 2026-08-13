/**
 * §5.3 replay: a journal-backed transport. Serves ONE recorded run's HTTP
 * exchanges — status and headers from the journal, bodies from the
 * content-addressed page files — in journal order, through the identical
 * transport interface the live CLI and the fixture tests use. A recorded walk
 * therefore re-runs through `ingestWindow` itself; replay is a store
 * capability, not a test convenience (critique M3).
 *
 * Run selection (I-M1): the journal is append-only, so a store that has
 * recorded more than one day holds more than one run. `createReplayTransport`
 * scopes to a single run — the given `runId`, or the newest run when none is
 * given — because every record already carries its `runId` (raw-store stamps
 * it). Without this, replay could only ever serve the first run's exchanges
 * positionally and a later run was permanently unreplayable.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport, TransportResponse } from '../ingest/ingest.js';
import { rawJournalPath, rawPagesDir } from './raw-store.js';

interface JournalRecord {
  kind: string;
  runId: string;
  url?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  bodyHash?: string;
}

interface HttpExchangeRecord {
  runId: string;
  url: string;
  status: number;
  responseHeaders: Record<string, string>;
  bodyHash: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function createReplayTransport(rootDir: string, opts?: { runId?: string }): Transport {
  const records = readFileSync(rawJournalPath(rootDir), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalRecord);

  // Distinct runIds in journal order — the last is the newest run.
  const runIds = [...new Set(records.map((record) => record.runId))];
  const runCount = runIds.length;
  const targetRunId = opts?.runId ?? runIds[runIds.length - 1];
  if (targetRunId === undefined) {
    throw new Error(`replay: journal at ${rootDir} holds no runs`);
  }
  if (opts?.runId !== undefined && !runIds.includes(opts.runId)) {
    throw new Error(
      `replay: no run «${opts.runId}» in the journal (holds ${runCount} run(s): ${runIds.join(', ')})`,
    );
  }

  const exchanges: HttpExchangeRecord[] = records
    .filter(
      (record): record is JournalRecord & HttpExchangeRecord =>
        record.kind === 'http' &&
        record.runId === targetRunId &&
        typeof record.url === 'string' &&
        typeof record.status === 'number' &&
        typeof record.bodyHash === 'string' &&
        typeof record.responseHeaders === 'object' &&
        record.responseHeaders !== null,
    )
    .map((record) => ({
      runId: record.runId,
      url: record.url,
      status: record.status,
      responseHeaders: record.responseHeaders,
      bodyHash: record.bodyHash,
    }));

  let position = 0;

  return async (url: string): Promise<TransportResponse> => {
    const record = exchanges[position];
    if (record === undefined) {
      throw new Error(
        `replay exhausted after ${exchanges.length} exchange(s) of run ${targetRunId} ` +
          `(journal holds ${runCount} run(s)); requested «${url}»`,
      );
    }
    if (record.url !== url) {
      throw new Error(
        `replay divergence at exchange ${position + 1} of run ${targetRunId} ` +
          `(journal holds ${runCount} run(s)): recorded «${record.url}», requested «${url}»`,
      );
    }
    // A foreign or tampered store must fail loudly, not be fed to the ingest
    // path (S-m2): the bodyHash must be a sha-256 hex digest, and the bytes on
    // disk must re-hash to it.
    if (!SHA256_HEX.test(record.bodyHash)) {
      throw new Error(
        `replay: journal bodyHash is not a sha-256 hex digest at exchange ${position + 1}: «${record.bodyHash}»`,
      );
    }
    const body = new Uint8Array(readFileSync(join(rawPagesDir(rootDir), record.bodyHash)));
    const actualHash = createHash('sha256').update(body).digest('hex');
    if (actualHash !== record.bodyHash) {
      throw new Error(
        `replay: body for exchange ${position + 1} hashes to ${actualHash}, ` +
          `journal records ${record.bodyHash} (store tampered or corrupt)`,
      );
    }
    position += 1;
    return {
      status: record.status,
      headers: { ...record.responseHeaders },
      body,
    };
  };
}
