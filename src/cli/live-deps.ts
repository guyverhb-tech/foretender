/**
 * Shared live dependencies for the CLI thin shells (`fetch-day.ts`,
 * `backfill.ts`): the real `fetch`-based transport, the real `sleep`, and the
 * contact `USER_AGENT`.
 *
 * This module is the ONLY place in the repo that references global `fetch`, so
 * the transport, the redirect handling, and the contact email are defined once
 * and cannot drift between the two shells. In particular the security-load-
 * bearing `redirect: 'manual'` (S-m1) lives here alone: were it duplicated,
 * tightening or loosening it on one CLI would silently leave the other on the
 * old behaviour, re-opening the origin-pin bypass on that path.
 */
import type { Transport } from '../ingest/ingest.js';

export const USER_AGENT = 'foretender/0.1 (contact: guyverhb@gmail.com)';

export const liveTransport: Transport = async (url) => {
  // redirect: 'manual' (S-m1): a 30x must not silently relocate the walk to
  // another host after the origin check in ingest — a 3xx falls through the
  // status !== 200 path and fails loudly, journaled.
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'manual',
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body };
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
