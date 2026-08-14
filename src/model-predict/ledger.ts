/**
 * The model-call ledger + record/replay client (slice 7; §5.3). A line-for-line
 * analogue of `src/store/raw-store.ts` + `replay.ts`, for
 * model calls instead of HTTP exchanges: an NDJSON journal plus SHA-256
 * content-addressed request/response bodies, idempotent on the request bytes and
 * replayable with ZERO network.
 *
 * The wrapper keys on `requestHash = sha256(serializeRequest(req))` — the bytes
 * the live shell sends — so a re-run of the same (ocid, promptVersion, cutoff)
 * finds the recorded call and returns it without an inner call and without spend.
 * A cache MISS (only reachable under `--live`) enforces the budget BEFORE calling
 * the inner, records request+response bytes write-once, appends one journal line,
 * and updates the in-memory index so an identical in-process request HITs
 * rather than double-spending.
 *
 * The secret never reaches disk: the `x-api-key` header is set only in the live
 * shell, and the recorded request body is `serializeRequest(req)` — which has no
 * key — so neither the journal nor the content-addressed bodies persist it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseModelResponse, serializeRequest } from './client.js';
import type { ModelClient, ModelRequest, ModelResult } from './client.js';

/** Code version stamped on every journal record as `v` (mirrors raw-store). */
const CODE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** A body file name is a sha-256 hex digest and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface LedgerOptions {
  inner: ModelClient;
  dir: string;
  now: () => number;
  predictorVersion: string;
  promptVersion: string;
  /** Max live (cache-miss) inner calls this client may make; undefined = unbounded. */
  maxLiveCalls?: number;
}

/** One journal record — the model-call analogue of an `http` exchange record. */
export interface ModelCallRecord {
  kind: 'model-call';
  callId: string;
  predictorVersion: string;
  promptVersion: string;
  model: string;
  requestHash: string;
  responseHash: string;
  usage: { input_tokens: number; output_tokens: number };
  /** From the injected clock — never wall time. */
  madeAt: number;
  v: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const journalPath = (dir: string): string => join(dir, 'journal.ndjson');
const bodiesDir = (dir: string): string => join(dir, 'bodies');

/** Read a content-addressed body by hash, failing loud on tampering (mirrors replay.ts). */
function readBody(dir: string, hash: string): Uint8Array {
  if (!SHA256_HEX.test(hash)) {
    throw new Error(`model-call ledger: bodyHash is not a sha-256 hex digest: «${hash}»`);
  }
  const body = new Uint8Array(readFileSync(join(bodiesDir(dir), hash)));
  const actual = sha256(body);
  if (actual !== hash) {
    throw new Error(
      `model-call ledger: body for ${hash} hashes to ${actual} (ledger tampered or corrupt)`,
    );
  }
  return body;
}

export function createLedgerClient(opts: LedgerOptions): ModelClient {
  const { inner, dir, now, predictorVersion, promptVersion, maxLiveCalls } = opts;

  // Scan the journal into the idempotency index (requestHash -> responseHash).
  const index = new Map<string, string>();
  const jpath = journalPath(dir);
  if (existsSync(jpath)) {
    for (const line of readFileSync(jpath, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const rec = JSON.parse(line) as { requestHash?: unknown; responseHash?: unknown };
      if (typeof rec.requestHash === 'string' && typeof rec.responseHash === 'string') {
        index.set(rec.requestHash, rec.responseHash);
      }
    }
  }

  let liveCalls = 0;

  return async (req: ModelRequest): Promise<ModelResult> => {
    const requestBytes = serializeRequest(req);
    const requestHash = sha256(requestBytes);

    const hitResponseHash = index.get(requestHash);
    if (hitResponseHash !== undefined) {
      // HIT: serve the recorded response from bytes — zero network, zero spend.
      const raw = readBody(dir, hitResponseHash);
      return { response: parseModelResponse(raw), raw };
    }

    // MISS: only reachable with a live inner. Enforce the budget BEFORE spending.
    if (maxLiveCalls !== undefined && liveCalls >= maxLiveCalls) {
      throw new Error(
        `model-call ledger: budget cap of ${maxLiveCalls} live call(s) reached; ` +
          'refusing to call the model (no recorded response for this request)',
      );
    }
    const result = await inner(req);
    liveCalls += 1;

    const responseHash = sha256(result.raw);
    mkdirSync(bodiesDir(dir), { recursive: true });
    const reqPath = join(bodiesDir(dir), requestHash);
    if (!existsSync(reqPath)) writeFileSync(reqPath, requestBytes, { flag: 'wx' });
    const resPath = join(bodiesDir(dir), responseHash);
    if (!existsSync(resPath)) writeFileSync(resPath, result.raw, { flag: 'wx' });

    const record: ModelCallRecord = {
      kind: 'model-call',
      callId: randomUUID(),
      predictorVersion,
      promptVersion,
      model: result.response.model,
      requestHash,
      responseHash,
      usage: {
        input_tokens: result.response.usage.input_tokens,
        output_tokens: result.response.usage.output_tokens,
      },
      madeAt: now(),
      v: CODE_VERSION,
    };
    appendFileSync(jpath, `${JSON.stringify(record)}\n`);

    // Index the write so an identical in-process request HITs (no double spend).
    index.set(requestHash, responseHash);
    return result;
  };
}
