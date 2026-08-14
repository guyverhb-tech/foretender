/**
 * Deterministic mock / recorded model clients for the model-predictor contract
 * tests (Phase 1 slice 7) — the model-call analogue of the fixture transport.
 *
 * Every client here returns a CANNED Anthropic response read verbatim from
 * `test/fixtures/model-calls/`, so predictions are produced with ZERO network
 * and ZERO spend: the `test/setup.ts` globalThis.fetch poison stays unfired by
 * construction (nothing in this file — or in the code it drives — touches the
 * wire). This is the same seam the LIVE shell (`src/cli/live-model.ts`) fills
 * with raw `fetch`; tests inject only the mock/replay path.
 *
 * The `ModelResult`/`ModelRequest`/`ModelResponse`/`ModelClient` TYPES are
 * imported (type-only) from the module under test so the mock's return shape is
 * pinned to the declared wire contract — a drift there fails the test, not the
 * mock. The response bytes are decoded with a plain `JSON.parse` (exactly what a
 * real client does), not via the SUT's own parser, so the mock does not depend
 * on the code it exists to exercise.
 */
import { readFixtureBytes } from './fixture-transport.js';
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelResult,
} from '../../src/model-predict/client.js';

/** The default canned response: end_turn, probability 0.42, valid strict JSON. */
export const DEFAULT_MODEL_FIXTURE = 'model-calls/valid-response.json';

/** Read one canned response fixture into a `ModelResult` (raw bytes + parsed envelope). */
export function loadModelResultFixture(rel: string = DEFAULT_MODEL_FIXTURE): ModelResult {
  const raw = readFixtureBytes(rel);
  const response = JSON.parse(new TextDecoder().decode(raw)) as ModelResponse;
  return { response, raw };
}

/**
 * A deterministic client returning the SAME canned response for every request
 * (keyed-by-input is unnecessary when one universal response drives the whole
 * corpus run). Each call hands back a fresh byte copy so a downstream ledger
 * writing `raw` cannot be perturbed by buffer aliasing.
 */
export function makeMockModelClient(rel: string = DEFAULT_MODEL_FIXTURE): ModelClient {
  const canned = loadModelResultFixture(rel);
  return async () => ({ response: canned.response, raw: canned.raw.slice() });
}

export interface CapturingModelClient {
  client: ModelClient;
  /** Every request the client was asked to send, in call order. */
  requests: ModelRequest[];
}

/**
 * As `makeMockModelClient`, but records each `ModelRequest` it is handed so a
 * test can inspect the rendered prompt (the no-leakage witness).
 */
export function makeCapturingModelClient(
  rel: string = DEFAULT_MODEL_FIXTURE,
): CapturingModelClient {
  const canned = loadModelResultFixture(rel);
  const requests: ModelRequest[] = [];
  const client: ModelClient = async (req) => {
    requests.push(req);
    return { response: canned.response, raw: canned.raw.slice() };
  };
  return { client, requests };
}

export interface ThrowingModelClient {
  client: ModelClient;
  /** Mutable call counter — an inner that a replay/budget path must never invoke. */
  state: { calls: number };
}

/**
 * A client that fails loud if ever called. It stands in as the INNER of a
 * replay ledger (a recorded run must serve every request from the ledger, never
 * the inner) and of a zero-budget ledger (a MISS must be refused before the
 * inner is touched). `state.calls` lets a test assert the inner stayed untouched.
 */
export function makeThrowingModelClient(): ThrowingModelClient {
  const state = { calls: 0 };
  const client: ModelClient = async () => {
    state.calls += 1;
    throw new Error('inner model client must not be called on the replay/budget path');
  };
  return { client, state };
}
