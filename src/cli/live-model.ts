/**
 * The LIVE Anthropic Messages transport (slice 7). This is
 * the ONLY file in the repo that touches the network for the model or reads
 * `ANTHROPIC_API_KEY` — the sibling of `live-deps.ts` for FTS. Every test injects
 * the mock/replay client instead, so `test/setup.ts`'s fetch-poison never sees
 * this file (it is imported by no test).
 *
 * The key is read from env (or an explicit override) and set only as the
 * `x-api-key` header — never in the request body — so nothing the ledger records
 * carries the secret. On a non-200 it fails loud surfacing the status and, on a
 * throttle/overload, the `retry-after` seconds (mirroring the FTS transport).
 */
import { parseModelResponse, serializeRequest } from '../model-predict/client.js';
import type { ModelClient, ModelRequest, ModelResult } from '../model-predict/client.js';

/** Point at the API host, never the docs host (research §"Sharp edges"). */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
/** The single load-bearing version string — mandatory on a raw `fetch` (research §2). */
const ANTHROPIC_VERSION = '2023-06-01';

export function liveModelClient(opts?: { apiKey?: string }): ModelClient {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error(
      'liveModelClient: ANTHROPIC_API_KEY is not set — export it (see .env.example) before running with --live',
    );
  }

  return async (req: ModelRequest): Promise<ModelResult> => {
    const body = serializeRequest(req);
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body,
      // A 30x must not silently relocate the POST to another host (mirrors live-deps.ts).
      redirect: 'manual',
    });
    const raw = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200) {
      const retryAfter = response.headers.get('retry-after');
      const hint =
        response.status === 401
          ? ' (authentication_error — check ANTHROPIC_API_KEY)'
          : retryAfter !== null
            ? ` (retry-after ${retryAfter}s)`
            : '';
      // Cap the diagnostic to a bounded snippet: enough to identify the upstream
      // error, never the whole body. No secret is echoed here (the request and its
      // x-api-key header are never interpolated), only the capped response body.
      const decoded = new TextDecoder().decode(raw);
      const snippet = decoded.length > 500 ? `${decoded.slice(0, 500)}… (${decoded.length} bytes)` : decoded;
      throw new Error(`liveModelClient: Anthropic API returned ${response.status}${hint}: ${snippet}`);
    }
    return { response: parseModelResponse(raw), raw };
  };
}
