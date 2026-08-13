/**
 * The whole-stream cursor-pagination walk (invariants #1–#6). One function
 * owns it; the live CLI and the contract tests drive the identical path
 * through injected dependencies — this module never touches global fetch.
 *
 * Every exit after `beginRun` is bracketed: the walk body runs inside a
 * try/catch that journals a terminal `run-end` (with the counts so far and
 * `ok:false`) and rethrows an `IngestError` carrying the partial summary, so a
 * transport/store/sleep rejection can never leave a run un-terminated (C-M2).
 */
import type { LastSeenRelease, RawStore, RunSummary, RunWindow } from '../store/raw-store.js';
import { validateRelease, type ReleaseIdentity } from './validate.js';

export interface TransportResponse {
  status: number;
  /** Lower-case-keyed headers. */
  headers: Record<string, string>;
  /** Verbatim body bytes — decoded only at the parse point below. */
  body: Uint8Array;
}

export type Transport = (url: string) => Promise<TransportResponse>;

export interface IngestDeps {
  transport: Transport;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  store: RawStore;
  /** Headers the transport sends, journaled as-sent on every exchange. */
  requestHeaders?: Record<string, string>;
}

export interface IngestOpts {
  updatedFrom: string;
  updatedTo: string;
  limit?: number;
  minSpacingMs?: number;
  /** Page ceiling per run (defaults to 500). Cycle/runaway guard, not a caller knob. */
  maxPages?: number;
  /** Accumulated materialised body ceiling per run, in bytes (defaults to 256 MiB). */
  maxBodyBytes?: number;
}

const BASE_URL = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const BASE_ORIGIN = new URL(BASE_URL).origin;
const DEFAULT_LIMIT = 100;
const DEFAULT_MIN_SPACING_MS = 13_000;
/** Invariant #3: when a 429/503 carries no Retry-After, sleep 30 s. */
const DEFAULT_RETRY_AFTER_S = 30;
/** Consecutive 429/503 answers for one URL before failing loudly. */
const MAX_CONSECUTIVE_RETRIES = 5;
/**
 * Retry-After ceiling (S-M2). The observed corpus value is 120 s; 300 s is
 * generous. A larger value is either a multi-day hang, or — past Node's
 * TIMEOUT_MAX — silently clamped to 1 ms, which would bypass the ≥13 s floor
 * and hammer the endpoint. Either way we fail loudly rather than sleep.
 */
const MAX_RETRY_AFTER_S = 300;
/** Page ceiling per run (S-M3). A London day is ~5 pages; 500 is generous. */
const DEFAULT_MAX_PAGES = 500;
/** Accumulated materialised body ceiling per run (S-M3): 256 MiB, bounded. */
const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;
/** Invariant #1/#2: window bounds are exactly 19-char London-local datetimes. */
const WINDOW_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

interface ReleasePackagePage {
  links?: { next?: string };
  releases: unknown[];
}

/**
 * Thrown when a run aborts after `beginRun`. Carries the partial `RunSummary`
 * also journaled to the terminal `run-end {ok:false}`, so the CLI can print a
 * partial summary alongside the error (C-M2).
 */
export class IngestError extends Error {
  readonly summary: RunSummary;
  constructor(message: string, summary: RunSummary) {
    super(message);
    this.name = 'IngestError';
    this.summary = summary;
  }
}

/**
 * A 200 body must be a release package: an object with a `releases` array.
 * Anything else — including bytes that fail JSON.parse — is unparseable.
 */
function parsePackagePage(body: Uint8Array): ReleasePackagePage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (!Array.isArray((parsed as { releases?: unknown }).releases)) return null;
  return parsed as ReleasePackagePage;
}

/**
 * Milliseconds to sleep before retrying a 429/503. Non-integer/non-positive
 * (including an HTTP-date form) falls back to the invariant #3 default of 30 s;
 * a value above the ceiling throws (S-M2).
 */
function retryAfterMs(headers: Record<string, string>): number {
  const header = headers['retry-after'];
  if (header === undefined) return DEFAULT_RETRY_AFTER_S * 1000;
  const seconds = Number(header);
  if (!Number.isInteger(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_S * 1000;
  if (seconds > MAX_RETRY_AFTER_S) {
    throw new Error(`Retry-After ${seconds}s exceeds the ${MAX_RETRY_AFTER_S}s ceiling`);
  }
  return seconds * 1000;
}

/** The parsed page's `links.next`, read defensively — the parse is an unchecked cast. */
function readNext(page: ReleasePackagePage): unknown {
  const links = (page as { links?: unknown }).links;
  if (typeof links !== 'object' || links === null) return undefined;
  return (links as { next?: unknown }).next;
}

/** True only when `url` parses and shares find-tender's origin (S-M1). */
function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === BASE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * A stable quarantine identity so re-runs re-quarantine nothing (C-M4): the
 * release `id` when it has one, else the page bytes + the release's position
 * (both stable across re-runs of the same window). Never serialises the
 * record, so it is total even for the pathological deep-nesting case (S-m4).
 */
function quarantineKeyFor(reason: string, record: unknown, bodyHash: string, ordinal: number): string {
  if (typeof record === 'object' && record !== null) {
    const id = (record as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return `${reason}:id:${id}`;
  }
  return `${reason}:${bodyHash}#${ordinal}`;
}

/**
 * Fetch one window of the whole stream into the store: politely paced (across
 * process boundaries, not just within one run), Retry-After honoured within a
 * ceiling, bounded in pages and bytes, every response persisted raw before
 * parsing, junk quarantined idempotently with reasons, idempotent against the
 * store's frozen accepted-id snapshot. Resolves to the run summary also
 * journaled on `run-end`; on abort, throws `IngestError` after a terminal
 * `run-end {ok:false}`.
 */
export async function ingestWindow(deps: IngestDeps, opts: IngestOpts): Promise<RunSummary> {
  const { transport, sleep, now, store } = deps;
  const requestHeaders = deps.requestHeaders ?? {};
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const minSpacingMs = opts.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Invariant #1/#2: window bounds are 19-char London-local datetimes and
  // nothing else. Validating here — the public library seam — stops a future
  // caller smuggling `&stages=` or a non-datetime into the query (S-m5). This
  // precedes beginRun: a rejected window opens no run, so there is no run-end
  // to bracket.
  if (!WINDOW_FORMAT.test(opts.updatedFrom) || !WINDOW_FORMAT.test(opts.updatedTo)) {
    throw new Error(
      'window bounds must be 19-char London-local datetimes (YYYY-MM-DDTHH:MM:SS), ' +
        `got «${opts.updatedFrom}»..«${opts.updatedTo}»`,
    );
  }

  const window: RunWindow = { updatedFrom: opts.updatedFrom, updatedTo: opts.updatedTo };

  store.beginRun(window, { limit, minSpacingMs, ua: requestHeaders['user-agent'] });
  const snapshot = store.snapshotIds();
  const acceptedThisRun = new Set<string>();
  // Cross-run pacing floor: the newest prior request across the whole store
  // (invariant #3 spans runs). null on a fresh store → no extra first sleep.
  const lastRequestAt = store.lastRequestEpochMs();

  let pages = 0;
  let seen = 0;
  let accepted = 0;
  let alreadyPresent = 0;
  // Release-level vs page-level quarantines are counted apart so the release
  // reconciliation seen == accepted + alreadyPresent + quarantined holds on
  // every path, including aborts (C-m2).
  let quarantined = 0;
  let quarantinedPages = 0;
  let lastSeenRelease: LastSeenRelease | null = null;
  let requestCount = 0;
  let totalBodyBytes = 0;

  let ended = false;
  const writeRunEnd = (ok: boolean): RunSummary => {
    const summary: RunSummary = {
      window,
      pages,
      seen,
      accepted,
      alreadyPresent,
      quarantined,
      quarantinedPages,
      lastSeenRelease,
      ok,
    };
    // Exactly one terminal record per run: guarded so the catch cannot
    // double-journal when the success path already wrote one.
    if (!ended) {
      ended = true;
      store.endRun(summary);
    }
    return summary;
  };

  // The parameter order (updatedFrom, updatedTo, limit) is a pinned
  // implementation convention for deterministic fixture routing — not an API
  // requirement (the server's `uri` echo is the effective query, not a
  // verbatim copy). Values are London-local datetimes whose `:` must not be
  // percent-encoded, so the URL is assembled verbatim.
  let currentUrl = `${BASE_URL}?updatedFrom=${window.updatedFrom}&updatedTo=${window.updatedTo}&limit=${limit}`;
  let nextUrl: string | undefined = currentUrl;
  const visited = new Set<string>();

  try {
    while (nextUrl !== undefined) {
      const url: string = nextUrl;
      currentUrl = url;
      // Bound the walk (S-M3): a page ceiling and a visited-URL set turn an
      // upstream `links.next` cycle (a routine API defect) into a loud, bounded
      // abort instead of thousands of requests/day forever.
      if (pages >= maxPages) {
        throw new Error(
          `page cap of ${maxPages} reached for window ${window.updatedFrom}..${window.updatedTo}`,
        );
      }
      if (visited.has(url)) {
        throw new Error(`links.next points at an already-fetched URL (cycle detected): ${url}`);
      }
      visited.add(url);

      let consecutiveRetries = 0;
      /** Set when the previous answer for this URL was a 429/503. */
      let retryDelayMs: number | null = null;
      let response: TransportResponse;
      let bodyHash: string;

      // Fetch the page, honouring Retry-After on 429/503 by retrying the SAME
      // URL. Every answer — including rate-limit responses — is persisted raw
      // and journaled before any status branching or decoding.
      for (;;) {
        if (requestCount === 0) {
          // First request of the run: pace off the store's newest prior
          // request so a back-to-back re-run still honours ≥13 s (C-M1).
          if (lastRequestAt !== null) {
            const waitMs = minSpacingMs - (now() - lastRequestAt);
            if (waitMs > 0) await sleep(waitMs);
          }
        } else {
          // ≥13 s between any two requests (invariant #3); a retry waits the
          // Retry-After duration, never less than the polite minimum.
          await sleep(retryDelayMs === null ? minSpacingMs : Math.max(retryDelayMs, minSpacingMs));
        }
        response = await transport(url);
        requestCount += 1;
        // Bound the materialised body length before persisting (S-M3): reject
        // an over-ceiling accumulation rather than OOM-ing or filling the disk
        // of an append-only store with no eviction path. NOT a content-length
        // check — live bodies are gzip-decoded before we see them.
        totalBodyBytes += response.body.length;
        if (totalBodyBytes > maxBodyBytes) {
          throw new Error(
            `run exceeded the ${maxBodyBytes}-byte body ceiling ` +
              `(accumulated ${totalBodyBytes} over ${requestCount} request(s)) at ${url}`,
          );
        }
        ({ bodyHash } = store.recordExchange({
          url,
          requestHeaders,
          status: response.status,
          responseHeaders: response.headers,
          contentType: response.headers['content-type'] ?? '',
          body: response.body,
        }));
        if (response.status !== 429 && response.status !== 503) break;
        // Rate-limit bodies are plain text — they are never decoded as JSON.
        consecutiveRetries += 1;
        if (consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) {
          throw new Error(
            `gave up after ${MAX_CONSECUTIVE_RETRIES} consecutive ${response.status} answers for ${url}`,
          );
        }
        retryDelayMs = retryAfterMs(response.headers);
      }

      if (response.status !== 200) {
        throw new Error(`unexpected HTTP ${response.status} from ${url} (persisted as ${bodyHash})`);
      }

      const page = parsePackagePage(response.body);
      if (page === null) {
        store.quarantine({
          reason: 'unparseable-page',
          bodyHash,
          url,
          key: `unparseable-page:${bodyHash}`,
        });
        quarantinedPages += 1;
        throw new Error(`unparseable 200 body from ${url} (persisted as ${bodyHash})`);
      }
      pages += 1;

      // Dedupe is a total function; first matching case wins. Case 2 (frozen
      // store snapshot) deliberately precedes case 3 (within-run seen): a
      // release the store already holds is not junk however many times the
      // server repeats it — quarantine measures data anomalies, not operator
      // re-runs (plan §Approach, critique N2).
      for (const entry of page.releases) {
        seen += 1;
        const invalid = validateRelease(entry);
        if (invalid !== null) {
          store.quarantine({
            reason: invalid.reason,
            record: entry,
            bodyHash,
            key: quarantineKeyFor(invalid.reason, entry, bodyHash, seen),
          });
          quarantined += 1;
          continue;
        }
        // validateRelease guarantees non-empty string id and ocid.
        const release = entry as ReleaseIdentity;
        // Last release SEEN with a valid identity, regardless of accept /
        // already-present / duplicate (invariant #5 resume state) — so an
        // accept-nothing re-run still records usable resume state, not null.
        // `date` is type-checked at the cast (S-m6: validate.ts checks
        // id/ocid only). This is deliberate last-*seen* (not last-*accepted*)
        // semantics; see the revision log's item-8 decision.
        const rawDate = (entry as { date?: unknown }).date;
        lastSeenRelease =
          typeof rawDate === 'string' ? { id: release.id, date: rawDate } : { id: release.id };
        if (snapshot.has(release.id)) {
          alreadyPresent += 1;
          continue;
        }
        if (acceptedThisRun.has(release.id)) {
          store.quarantine({
            reason: 'duplicate-id',
            record: entry,
            bodyHash,
            key: quarantineKeyFor('duplicate-id', entry, bodyHash, seen),
          });
          quarantined += 1;
          continue;
        }
        store.addRelease({ id: release.id, ocid: release.ocid, bodyHash });
        acceptedThisRun.add(release.id);
        accepted += 1;
      }

      // Termination is the ABSENCE of `links` (invariant #4). A present-but
      // non-string or off-origin `next` is NOT followed: it is quarantined and
      // the run aborts loudly (S-M1) — the walk must never pivot off
      // find-tender's origin and persist a foreign body into the
      // replay-foundational store.
      const next = readNext(page);
      if (next === undefined) {
        nextUrl = undefined;
      } else if (typeof next !== 'string' || !sameOrigin(next)) {
        store.quarantine({
          reason: 'off-origin-next',
          bodyHash,
          url,
          next: typeof next === 'string' ? next : String(next),
          key: `off-origin-next:${bodyHash}`,
        });
        quarantinedPages += 1;
        throw new Error(
          `links.next is not a same-origin string: ` +
            `${typeof next === 'string' ? next : typeof next} (page persisted as ${bodyHash})`,
        );
      } else {
        nextUrl = next;
      }
    }

    return writeRunEnd(true);
  } catch (error) {
    // Every exit after beginRun terminates the run and preserves the partial
    // summary, naming the failing URL (C-M2).
    const summary = writeRunEnd(false);
    const message = error instanceof Error ? error.message : String(error);
    throw new IngestError(message.includes(currentUrl) ? message : `${message} (at ${currentUrl})`, summary);
  }
}
