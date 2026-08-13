/**
 * Sequenced fixture transport (plan step 5, critiques M2/m6).
 *
 * Maps each URL to an ORDERED SEQUENCE of recorded exchanges, consumed in
 * order — this is what makes the real same-URL 429→200 retry pair
 * (probe/20 → probe/22) servable at all. A request for an unknown URL or an
 * exhausted sequence throws naming the URL, so a wrongly constructed URL
 * fails as "no fixture matches «url»", not as a TypeError deep in the walk.
 *
 * Bodies cross this boundary as bytes (Uint8Array), read from the fixture
 * files without decoding (critique M4). The JSON.parse in loadFixturePage is
 * test-side ROUTING only (to read `uri` / `links.next`); the body served to
 * the code under test stays the raw fixture bytes.
 *
 * Types are declared locally and structurally, on purpose: this helper must
 * not import from src/, so it cannot inherit assumptions from the
 * implementation it exists to test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type Transport = (url: string) => Promise<TransportResponse>;

export interface RecordedExchange {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ReleaseIdentity {
  id: string;
  ocid: string;
  date?: string;
}

export interface PackagePage {
  uri: string;
  links?: { next?: string };
  releases: ReleaseIdentity[];
}

/** Absolute path to a committed fixture (plan step 1 copies them here). */
export function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

/** Raw fixture bytes — no decode, ever (critique M4). */
export function readFixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(rel)));
}

/**
 * Parse a curl-style `.headers` fixture: `HTTP/2 <status> ` first line, then
 * `key: value` lines. Keys lower-cased; repeated keys joined with ", ".
 */
export function parseHeadersFixture(rel: string): {
  status: number;
  headers: Record<string, string>;
} {
  const text = readFileSync(fixturePath(rel), 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const statusLine = lines[0] ?? '';
  const status = Number(statusLine.trim().split(/\s+/)[1]);
  if (!Number.isInteger(status)) {
    throw new Error(`cannot parse status line of ${rel}: «${statusLine}»`);
  }
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  return { status, headers };
}

/** A recorded exchange: status + headers from a `.headers` fixture, body bytes from its pair. */
export function exchangeFromFixture(bodyRel: string, headersRel: string): RecordedExchange {
  const { status, headers } = parseHeadersFixture(headersRel);
  return { status, headers, body: readFixtureBytes(bodyRel) };
}

export interface FixtureTransport {
  transport: Transport;
  /** Every URL requested, in order. */
  calls: string[];
}

/**
 * Build the transport from URL → ordered exchange sequences. Each sequence is
 * consumed front-to-back; unknown URL / exhausted sequence throw naming the
 * URL (critique m6).
 */
export function makeFixtureTransport(
  routes: Record<string, RecordedExchange[]>,
): FixtureTransport {
  const queues = new Map<string, RecordedExchange[]>(
    Object.entries(routes).map(([url, seq]) => [url, [...seq]]),
  );
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url);
    const queue = queues.get(url);
    if (queue === undefined) {
      throw new Error(`no fixture matches «${url}»`);
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fixture sequence exhausted for «${url}»`);
    }
    return { status: next.status, headers: { ...next.headers }, body: next.body.slice() };
  };
  return { transport, calls };
}

export interface FixturePage {
  name: string;
  exchange: RecordedExchange;
  pkg: PackagePage;
}

/**
 * Load one recorded page from `test/fixtures/<subdir>/<name>.{json,headers}`.
 * The JSON.parse is test-side ROUTING decode only (to read `uri`/`links.next`);
 * the served body stays raw fixture bytes (critique M4). `name` is stored
 * subdir-qualified (e.g. `whole-stream/page-001`, `backfill/2026-08-11/page-003`)
 * so a mis-chained fixture names itself — and, for a backfill page, its day.
 */
export function loadFixturePage(subdir: string, name: string): FixturePage {
  const exchange = exchangeFromFixture(`${subdir}/${name}.json`, `${subdir}/${name}.headers`);
  const pkg = JSON.parse(new TextDecoder().decode(exchange.body)) as PackagePage;
  return { name: `${subdir}/${name}`, exchange, pkg };
}

/** A loaded page sequence routed as a cursor-less-first-page walk. */
export interface RoutableChain {
  pages: FixturePage[];
  /** page-001's own `uri` — the genuine cursor-less first-page URL. */
  initialUrl: string;
  routes: Record<string, RecordedExchange[]>;
  /** Every release entry across the chain, in fetch order. */
  releasesInFetchOrder: ReleaseIdentity[];
}

/**
 * The one routing rule for a fixture walk, held once: page-001 is keyed on its
 * own `uri`; every later page is keyed on the PREVIOUS page's `links.next` —
 * the server echoes `uri` without the cursor (plan §Context). Callers pass the
 * already-loaded page sequence; page *discovery* (synthetic hops vs on-disk
 * walk) is the genuinely distinct part and stays with each caller.
 */
export function chainPages(pages: FixturePage[]): Omit<RoutableChain, 'pages'> {
  const first = pages[0];
  if (first === undefined) throw new Error('fixture chain is empty');
  const initialUrl = first.pkg.uri;
  const routes: Record<string, RecordedExchange[]> = { [initialUrl]: [first.exchange] };
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1];
    const page = pages[i];
    if (prev === undefined || page === undefined) throw new Error('fixture chain gap');
    const next = prev.pkg.links?.next;
    if (next === undefined) {
      throw new Error(`fixture ${prev.name} has no links.next to chain from`);
    }
    routes[next] = [page.exchange];
  }
  const releasesInFetchOrder = pages.flatMap((p) => p.pkg.releases);
  return { initialUrl, routes, releasesInFetchOrder };
}

/**
 * The five-page whole-stream fixture chain: 001 → 002 → 003 → 050 → 111.
 *
 * The hops 003→050 and 050→111 are synthetic routing of unedited real bodies
 * (plan step 1, critique N1); every body is byte-identical to the recording.
 * 437 release entries across the chain, 436 unique. Routing rule: `chainPages`.
 */
export function wholeStreamChain(): RoutableChain {
  const names = ['page-001', 'page-002', 'page-003', 'page-050', 'page-111'];
  const pages = names.map((name) => loadFixturePage('whole-stream', name));
  return { pages, ...chainPages(pages) };
}

/**
 * Load one committed backfill day (`test/fixtures/backfill/<day>/`) as a
 * routable chain, using the same routing rule as `wholeStreamChain`
 * (`chainPages`). Unlike `whole-stream/` these are genuine recorded chains — no
 * synthetic hops. The page count is discovered from disk (the distinct part),
 * so a 5- or 6-page day both load correctly.
 */
export function loadBackfillDay(day: string): RoutableChain {
  const pages: FixturePage[] = [];
  for (let n = 1; ; n++) {
    const name = `page-${String(n).padStart(3, '0')}`;
    if (!existsSync(fixturePath(`backfill/${day}/${name}.json`))) break;
    pages.push(loadFixturePage(`backfill/${day}`, name));
  }
  if (pages.length === 0) throw new Error(`no backfill fixtures for day ${day}`);
  return { pages, ...chainPages(pages) };
}

/**
 * Merge several days' per-day route maps into one collision-free map. The
 * days' URL keyspaces are disjoint (each cursor embeds its day's window), so a
 * shared key is a routing bug — throw loudly rather than silently overwrite.
 */
export function backfillRoutes(days: string[]): Record<string, RecordedExchange[]> {
  const merged: Record<string, RecordedExchange[]> = {};
  for (const day of days) {
    for (const [url, seq] of Object.entries(loadBackfillDay(day).routes)) {
      if (url in merged) throw new Error(`route collision across days on «${url}»`);
      merged[url] = seq;
    }
  }
  return merged;
}
