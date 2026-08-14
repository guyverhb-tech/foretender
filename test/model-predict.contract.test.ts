import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ingestWindow } from '../src/ingest/ingest.js';
import { createRawStore } from '../src/store/raw-store.js';
import { reconstructOne } from '../src/lifecycle/machine.js';
import { readEventsByOcid } from '../src/lifecycle/read.js';
import type { LifecycleEvent } from '../src/lifecycle/model.js';
import { PREDICTOR_VERSION } from '../src/prediction/model.js';
import type { Prediction } from '../src/prediction/model.js';
import { grade } from '../src/grading/grade.js';
import { calibrate } from '../src/grading/calibrate.js';
import { gradePredictions } from '../src/grading/project.js';
import type { PredictionRecord, Scoreboard, Verdict } from '../src/grading/model.js';

// Modules under test — none exist until the builder implements slice 7. These
// imports fail to resolve on a pre-build tree, which is the correct spec-first
// state (see .harness/test-plan.md §"Expected state on return").
import {
  predictWithModel,
  parseModelOutput,
  MODEL_PREDICTOR_VERSION,
} from '../src/model-predict/predict.js';
import { projectModelPredictions } from '../src/model-predict/project.js';
import { createLedgerClient } from '../src/model-predict/ledger.js';
import { PROMPT_VERSION } from '../src/model-predict/prompt.js';
import type { ModelRequest, ModelResponse } from '../src/model-predict/client.js';

import {
  chainPages,
  loadBackfillDay,
  loadFixturePage,
  makeFixtureTransport,
  wholeStreamChain,
} from './helpers/fixture-transport.js';
import { makeVirtualClock, makeVirtualSleep, readNdjson } from './helpers/support.js';
import {
  makeCapturingModelClient,
  makeMockModelClient,
  makeThrowingModelClient,
} from './helpers/model-client.js';

/**
 * Model-based predictor contract (Phase 1 slice 7; brief reqs 3–8 + BINDING
 * ADDENDA A1–A5) — fixture-only, ZERO network by construction. Every model call
 * is served by the deterministic mock/recorded client
 * (`test/helpers/model-client.ts`); `test/setup.ts` poisons globalThis.fetch as
 * the backstop, and the load-bearing tests additionally spy the global to assert
 * the poison stays UNFIRED (fetchCalls === 0).
 *
 * The four things this suite must bite on (task brief):
 *   NO-LEAKAGE (A2). Over the real inversion witness (planning 075541 dated
 *   EARLIER but higher-id; tender 075540 dated LATER but lower-id), the rendered
 *   prompt EXCLUDES the post-cutoff release id `075540` EXACTLY while the as-of
 *   planning id `075541` IS present. We do NOT assert the word "tender" is absent
 *   (A2: the pipeline-to-tender task names its own target).
 *
 *   REPLAY DETERMINISM (§5.3). A recorded run replays byte-identically from the
 *   model-call ledger with a THROWING inner — proving every request is served
 *   from the ledger, not re-called — with zero network.
 *
 *   FAIL-LOUD PARSE. A malformed model output THROWS rather than yielding a
 *   silent wrong-but-valid Prediction.
 *
 *   GRADING PARITY / HEAD-TO-HEAD (A1). Model rows land in the shared
 *   predictions.ndjson keyed by predictorVersion, are graded by the UNMODIFIED
 *   slice-5 grader, and partitioning the returned Prediction[] by predictorVersion
 *   yields a separable baseline-vs-model scoreboard (the `byPredictor` map the
 *   CLI writes to scoreboard-by-predictor.json).
 *
 * Interface assumptions (see .harness/test-plan.md §Interface assumptions):
 *   parseModelOutput(r: ModelResponse): { probability: number; rationale: string }  // throws loud
 *   predictWithModel(events, releases, opts, client): Promise<Prediction | null>
 *   projectModelPredictions(root, opts, client): Promise<{ predictions: Prediction[]; ... }>  // A1
 *   createLedgerClient({ inner, dir, now, predictorVersion, promptVersion, maxLiveCalls? }): ModelClient
 *   MODEL_PREDICTOR_VERSION === 'model:claude-sonnet-5@v1'; PROMPT_VERSION exported + stamped
 */

// ── shared instruments ──────────────────────────────────────────────────────

/** A hand-built lifecycle event (mirrors the slice-5 `mkEvent` helper). */
function mkEvent(
  ocid: string,
  releaseId: string,
  tag: string[],
  noticeType: string | null = null,
  date: string | null = null,
): LifecycleEvent {
  return { ocid, releaseId, tag, noticeType, date, regime: null };
}

/** Narrow a nullable to non-null with a failing message (keeps the assertion sharp). */
function notNull<T>(v: T | null, msg: string): T {
  if (v === null) throw new Error(msg);
  return v;
}

const USAGE = { input_tokens: 10, output_tokens: 5 };
function envelope(content: ModelResponse['content'], stopReason: string | null = 'end_turn'): ModelResponse {
  return { id: 'msg_test', model: 'claude-sonnet-5', content, stop_reason: stopReason, usage: USAGE };
}
function textEnvelope(text: string, stopReason: string | null = 'end_turn'): ModelResponse {
  return envelope([{ type: 'text', text }], stopReason);
}

/** A fixed injected clock value — distinct from every corpus date, so a wall-clock leak shows. */
const FIXED_NOW = 1_700_000_000_000;

/**
 * Run `fn` with a counting wrapper around the global fetch poison, returning the
 * result and the number of fetch attempts. A passing test asserts fetchCalls === 0
 * — the explicit "zero network by construction" signal (any real attempt would
 * also throw via the underlying poison). The original global is always restored.
 */
async function runWithNoNetwork<T>(fn: () => Promise<T>): Promise<{ result: T; fetchCalls: number }> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: unknown[]): unknown => {
    calls += 1;
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof fetch;
  try {
    const result = await fn();
    return { result, fetchCalls: calls };
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Extract the Prediction[] projectModelPredictions wrote (addendum A1: it MUST
 * return them). Tolerant of the exact container — a bare array or `{ predictions }`
 * — because A1 pins the presence of the rows, not the wrapper shape.
 */
function returnedPredictions(ret: unknown): Prediction[] {
  if (Array.isArray(ret)) return ret as Prediction[];
  if (ret !== null && typeof ret === 'object') {
    const preds = (ret as { predictions?: unknown }).predictions;
    if (Array.isArray(preds)) return preds as Prediction[];
  }
  throw new Error('projectModelPredictions must return the written Prediction[] (addendum A1)');
}

// ── FAIL-LOUD PARSE (brief req 3; a bad output never becomes a silent Prediction)

describe('parseModelOutput — fails loud on a malformed model output (brief req 3)', () => {
  it('accepts a well-formed strict-JSON output and returns the parsed probability + rationale', () => {
    const out = parseModelOutput(textEnvelope('{"probability": 0.42, "rationale": "ok"}'));
    expect(out.probability).toBe(0.42);
    expect(out.rationale).toBe('ok');
  });

  it('accepts the inclusive boundaries probability 0 and probability 1', () => {
    expect(parseModelOutput(textEnvelope('{"probability": 0, "rationale": "x"}')).probability).toBe(0);
    expect(parseModelOutput(textEnvelope('{"probability": 1, "rationale": "x"}')).probability).toBe(1);
  });

  it('THROWS when the text block is not JSON', () => {
    expect(() => parseModelOutput(textEnvelope('not json at all'))).toThrow();
  });

  it('THROWS when probability is above 1', () => {
    expect(() => parseModelOutput(textEnvelope('{"probability": 1.5, "rationale": "x"}'))).toThrow();
  });

  it('THROWS when probability is below 0', () => {
    expect(() => parseModelOutput(textEnvelope('{"probability": -0.1, "rationale": "x"}'))).toThrow();
  });

  it('THROWS when probability is missing', () => {
    expect(() => parseModelOutput(textEnvelope('{"rationale": "x"}'))).toThrow();
  });

  it('THROWS when probability is non-finite (JSON 1e999 parses to Infinity)', () => {
    expect(() => parseModelOutput(textEnvelope('{"probability": 1e999, "rationale": "x"}'))).toThrow();
  });

  it('THROWS when probability is not a number (a JSON string)', () => {
    expect(() => parseModelOutput(textEnvelope('{"probability": "0.5", "rationale": "x"}'))).toThrow();
  });

  it('THROWS when rationale is missing (not a string)', () => {
    expect(() => parseModelOutput(textEnvelope('{"probability": 0.5}'))).toThrow();
  });

  it('THROWS when stop_reason is "max_tokens" even if the text is valid JSON', () => {
    expect(() =>
      parseModelOutput(textEnvelope('{"probability": 0.5, "rationale": "x"}', 'max_tokens')),
    ).toThrow();
  });

  it('THROWS when stop_reason is "refusal"', () => {
    expect(() =>
      parseModelOutput(textEnvelope('{"probability": 0.5, "rationale": "x"}', 'refusal')),
    ).toThrow();
  });

  it('THROWS when content is empty', () => {
    expect(() => parseModelOutput(envelope([]))).toThrow();
  });

  it('THROWS when there is no text block (only a non-text block)', () => {
    expect(() => parseModelOutput(envelope([{ type: 'tool_use' }]))).toThrow();
  });

  it('THROWS when the text block carries no text field', () => {
    expect(() => parseModelOutput(envelope([{ type: 'text' }]))).toThrow();
  });
});

// ── NO-LEAKAGE (brief req 4; A2 — the crux) ─────────────────────────────────

describe('predictWithModel — no leakage of post-cutoff releases into the prompt (brief req 4; A2)', () => {
  const NOLEAK = 'ocds-h6vhtk-inv999';
  const PLANNING_ID = '075541-2026'; // dated EARLIER, higher id
  const TENDER_ID = '075540-2026'; // dated LATER, lower id — the post-cutoff outcome

  // The real committed inversion (backfill/2026-08-10/page-005), assembled into
  // one synthetic ocid. base.madeAt is the planning date, so the as-of cutoff
  // excludes the 1-second-later tender — the model must never see 075540.
  const events: LifecycleEvent[] = [
    mkEvent(NOLEAK, PLANNING_ID, ['planning'], 'UK3', '2026-08-10T09:26:26+01:00'),
    mkEvent(NOLEAK, TENDER_ID, ['tender'], null, '2026-08-10T09:26:27+01:00'),
  ];
  // Raw releases for the identity join. The planning carries a title but NO buyer;
  // the tender carries a canary buyer/title. Under a correct as-of join (planning
  // only) the canary is absent; a join that pulled in the post-cutoff tender would
  // surface `LEAK-CANARY` — a distinguishing signal that is NOT the word "tender".
  const releases = [
    {
      id: PLANNING_ID,
      ocid: NOLEAK,
      tag: ['planning'],
      date: '2026-08-10T09:26:26+01:00',
      planning: { title: 'Lighthouse renewal programme' },
    },
    {
      id: TENDER_ID,
      ocid: NOLEAK,
      tag: ['tender'],
      date: '2026-08-10T09:26:27+01:00',
      buyer: { name: 'LEAK-CANARY-BUYER-075540' },
      tender: { title: 'LEAK-CANARY-TITLE-075540' },
    },
  ];

  it('emits the honest pipeline model prediction and never shows the model the post-cutoff tender id', async () => {
    const capture = makeCapturingModelClient();
    const { result, fetchCalls } = await runWithNoNetwork(async () =>
      predictWithModel(events, releases, { asof: '2026-08-11T00:00:00Z' }, capture.client),
    );
    expect(fetchCalls).toBe(0);

    const p = notNull(result, 'expected a non-null pipeline model prediction over the inversion witness');
    expect(p.type).toBe('pipeline-to-tender');
    expect(p.noticeType).toBe('UK3');
    expect(p.predictorVersion).toBe(MODEL_PREDICTOR_VERSION);
    expect(p.predictedProbability).toBe(0.42); // the mock's number, parsed and carried through

    expect(capture.requests).toHaveLength(1);
    const req = notNull(capture.requests[0] ?? null, 'expected exactly one captured model request');
    const promptText = JSON.stringify(req);

    // Positive control: the as-of planning release IS present (A2) — makes the
    // 075540 absence a real signal rather than a vacuous one.
    expect(promptText).toContain('075541');
    // A2 crux: the post-cutoff tender's id is absent EXACTLY (075541, which shares
    // the `07554` prefix, is present and expected — so this is not a prefix test).
    expect(promptText).not.toContain('075540');
    // The excluded tender's distinguishing identity content is absent too.
    expect(promptText).not.toContain('LEAK-CANARY');

    // Both axes bite: the FULL-truth fold over every event IS tender, yet the model
    // was shown a pipeline-only as-of set — the outcome was withheld, not just late.
    expect(reconstructOne(events).state).toBe('tender');
  });

  it('excludes a NULL-dated post-cutoff release from the prompt and the identity join (A3)', async () => {
    // A3: the as-of filter must guard `toEpochMs(date) !== null` — a null date
    // coerces `null <= cutoff` to true, a latent leak. A null-dated tender carrying
    // a canary buyer must never reach the prompt or the identity join.
    const NULLID = '099999-2026'; // higher id than the planning release
    const evs: LifecycleEvent[] = [
      mkEvent(NOLEAK, PLANNING_ID, ['planning'], 'UK3', '2026-08-10T09:26:26+01:00'),
      mkEvent(NOLEAK, NULLID, ['tender'], null, null),
    ];
    const rels = [
      {
        id: PLANNING_ID,
        ocid: NOLEAK,
        tag: ['planning'],
        date: '2026-08-10T09:26:26+01:00',
        planning: { title: 'Lighthouse renewal programme' },
      },
      { id: NULLID, ocid: NOLEAK, tag: ['tender'], date: null, buyer: { name: 'NULLDATE-CANARY-099999' } },
    ];
    const capture = makeCapturingModelClient();
    const p = notNull(
      await predictWithModel(evs, rels, { asof: '2026-08-11T00:00:00Z' }, capture.client),
      'expected a non-null pipeline prediction with the null-dated release excluded',
    );
    expect(p.noticeType).toBe('UK3');
    const req = notNull(capture.requests[0] ?? null, 'expected exactly one captured model request');
    const promptText = JSON.stringify(req);
    expect(promptText).not.toContain('099999'); // the null-dated event never entered the as-of set
    expect(promptText).not.toContain('NULLDATE-CANARY'); // nor the identity join
  });
});

// ── BUDGET / SAFETY (brief req 7; A5 — a miss under a zero cap refuses to spend)

describe('createLedgerClient — a budget cap of 0 refuses to call the inner on a miss (brief req 7; A5)', () => {
  it('rejects a cache MISS and never touches the inner client (no spend, no network)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foretender-ledger-budget-'));
    try {
      const inner = makeThrowingModelClient();
      const client = createLedgerClient({
        inner: inner.client,
        dir: join(dir, 'model-calls'),
        now: () => FIXED_NOW,
        predictorVersion: MODEL_PREDICTOR_VERSION,
        promptVersion: PROMPT_VERSION,
        maxLiveCalls: 0,
      });
      const req: ModelRequest = {
        model: 'claude-sonnet-5',
        max_tokens: 512,
        messages: [{ role: 'user', content: 'unrecorded request' }],
      };
      const { fetchCalls } = await runWithNoNetwork(async () => {
        await expect(client(req)).rejects.toThrow();
      });
      expect(inner.state.calls).toBe(0); // the cap fired BEFORE the inner was reached
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── End-to-end over the committed corpus (reqs 5–6; §5.3; A1) ────────────────

const T0 = Date.UTC(2026, 7, 12, 9, 0, 0);
const WHOLE_STREAM_WINDOW = { updatedFrom: '2026-07-13T00:00:00', updatedTo: '2026-08-12T00:00:00' };
const DAY_WINDOWS: Record<string, { updatedFrom: string; updatedTo: string }> = {
  '2026-08-10': { updatedFrom: '2026-08-10T00:00:00', updatedTo: '2026-08-11T00:00:00' },
  '2026-08-11': { updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' },
  '2026-08-12': { updatedFrom: '2026-08-12T00:00:00', updatedTo: '2026-08-13T00:00:00' },
};
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'] as const;
const CONVERSION_WINDOW = { updatedFrom: '2026-07-22T00:00:00', updatedTo: '2026-07-23T00:00:00' };
const ASOF = '2026-09-01T00:00:00Z';
const CONVERSION_OCID = 'ocds-h6vhtk-069311';

const predictionsPath = (root: string): string => join(root, 'predictions.ndjson');

/**
 * Build ONE temp store from the committed corpus (whole-stream chain + three
 * backfill days) PLUS the curated UK3 conversion chain — exactly as
 * prediction-grading.contract.test.ts:buildFullStore does, on one shared virtual
 * clock through the injected fixture transport (zero network).
 */
async function buildFullStore(root: string): Promise<void> {
  const clock = makeVirtualClock(T0);
  const { sleep } = makeVirtualSleep(clock);

  {
    const chain = wholeStreamChain();
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...WHOLE_STREAM_WINDOW });
  }
  for (const day of DAYS) {
    const chain = loadBackfillDay(day);
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    const window = DAY_WINDOWS[day];
    if (window === undefined) throw new Error(`no window for day ${day}`);
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...window });
  }
  {
    const page = loadFixturePage('conversions', 'uk3-069311');
    const chain = chainPages([page]);
    const { transport } = makeFixtureTransport(chain.routes);
    const store = createRawStore(root, { now: clock.now });
    await ingestWindow({ transport, sleep, now: clock.now, store }, { ...CONVERSION_WINDOW });
  }
}

/** Grade one predictorVersion partition with the UNMODIFIED pure grader. */
function gradePartition(
  rows: Prediction[],
  eventsByOcid: Map<string, LifecycleEvent[]>,
  asof: string,
): Verdict[] {
  return rows.map((p) => {
    const rec: PredictionRecord = {
      ocid: p.ocid,
      noticeType: p.noticeType,
      predictedProbability: p.predictedProbability,
      expectedResolutionDate: p.expectedResolutionDate,
      madeAt: p.madeAt,
    };
    return grade(rec, eventsByOcid.get(p.ocid) ?? [], { asof });
  });
}

describe('model predictor over the committed corpus (brief reqs 5–6; §5.3; A1)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foretender-model-'));
    await buildFullStore(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('§5.3: a recorded run replays byte-identically from the ledger with zero network', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'foretender-mcl-'));
    try {
      const { result, fetchCalls } = await runWithNoNetwork(async () => {
        // RECORD — the mock stands in for the live client; each unique request is
        // journalled and its response content-addressed.
        const record = createLedgerClient({
          inner: makeMockModelClient(),
          dir: join(ledgerDir, 'model-calls'),
          now: () => FIXED_NOW,
          predictorVersion: MODEL_PREDICTOR_VERSION,
          promptVersion: PROMPT_VERSION,
        });
        const ret1 = returnedPredictions(await projectModelPredictions(root, { asof: ASOF }, record));
        const predBytes1 = readFileSync(predictionsPath(root));
        const journalFile = join(ledgerDir, 'model-calls', 'journal.ndjson');
        const journalBytes1 = readFileSync(journalFile);

        // REPLAY — a THROWING inner proves every request is served from the ledger.
        const throwing = makeThrowingModelClient();
        const replay = createLedgerClient({
          inner: throwing.client,
          dir: join(ledgerDir, 'model-calls'),
          now: () => FIXED_NOW + 999_999, // a different clock — must not perturb replay
          predictorVersion: MODEL_PREDICTOR_VERSION,
          promptVersion: PROMPT_VERSION,
        });
        const ret2 = returnedPredictions(await projectModelPredictions(root, { asof: ASOF }, replay));
        const predBytes2 = readFileSync(predictionsPath(root));
        const journalBytes2 = readFileSync(journalFile);

        return {
          ret1,
          ret2,
          predBytes1,
          predBytes2,
          journalBytes1,
          journalBytes2,
          innerCalls: throwing.state.calls,
          journalFile,
        };
      });

      expect(fetchCalls).toBe(0); // zero network across BOTH record and replay
      expect(result.innerCalls).toBe(0); // replay served everything from the ledger
      expect(result.predBytes2.equals(result.predBytes1)).toBe(true); // byte-identical predictions
      expect(result.journalBytes2.equals(result.journalBytes1)).toBe(true); // replay appended nothing

      // ≥1 model prediction recorded, one journal line per unique request (idempotent).
      const modelRows = result.ret1.filter((p) => p.predictorVersion === MODEL_PREDICTOR_VERSION);
      expect(modelRows.length).toBeGreaterThanOrEqual(1);
      expect(readNdjson(result.journalFile).length).toBe(modelRows.length);
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('journals each call faithfully to the injected clock and never persists a secret', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'foretender-mcl2-'));
    try {
      const record = createLedgerClient({
        inner: makeMockModelClient(),
        dir: join(ledgerDir, 'model-calls'),
        now: () => FIXED_NOW,
        predictorVersion: MODEL_PREDICTOR_VERSION,
        promptVersion: PROMPT_VERSION,
      });
      await projectModelPredictions(root, { asof: ASOF }, record);

      const journalFile = join(ledgerDir, 'model-calls', 'journal.ndjson');
      const journal = readNdjson(journalFile);
      expect(journal.length).toBeGreaterThanOrEqual(1);
      for (const rec of journal) {
        expect(rec['kind']).toBe('model-call');
        expect(rec['predictorVersion']).toBe(MODEL_PREDICTOR_VERSION);
        expect(rec['promptVersion']).toBe(PROMPT_VERSION);
        expect(rec['model']).toBe('claude-sonnet-5');
        expect(rec['madeAt']).toBe(FIXED_NOW); // the injected clock, never wall time
        const usage = rec['usage'] as Record<string, unknown>;
        expect(typeof usage['input_tokens']).toBe('number');
        expect(typeof usage['output_tokens']).toBe('number');
      }

      // The API key is a live-shell header only — it must never reach the ledger
      // (journal or the content-addressed request/response bodies).
      const journalText = readFileSync(journalFile, 'utf8').toLowerCase();
      expect(journalText).not.toContain('x-api-key');
      expect(journalText).not.toContain('anthropic_api_key');
      const bodiesDir = join(ledgerDir, 'model-calls', 'bodies');
      for (const f of readdirSync(bodiesDir)) {
        const text = readFileSync(join(bodiesDir, f), 'utf8').toLowerCase();
        expect(text).not.toContain('x-api-key');
        expect(text).not.toContain('anthropic_api_key');
      }
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('two recorded runs write a byte-identical predictions.ndjson (deterministic rebuild)', async () => {
    const mock = makeMockModelClient();
    await projectModelPredictions(root, { asof: ASOF }, mock);
    const first = readFileSync(predictionsPath(root));
    await projectModelPredictions(root, { asof: ASOF }, makeMockModelClient());
    const second = readFileSync(predictionsPath(root));
    expect(second.equals(first)).toBe(true);
  });

  it('writes BOTH predictors into the shared ledger, keyed by predictorVersion, without collision (A1)', async () => {
    const { result: predictions, fetchCalls } = await runWithNoNetwork(async () =>
      returnedPredictions(await projectModelPredictions(root, { asof: ASOF }, makeMockModelClient())),
    );
    expect(fetchCalls).toBe(0);

    const modelRows = predictions.filter((p) => p.predictorVersion === MODEL_PREDICTOR_VERSION);
    const baseRows = predictions.filter((p) => p.predictorVersion === PREDICTOR_VERSION);
    expect(modelRows.length).toBeGreaterThanOrEqual(1);
    expect(baseRows.length).toBeGreaterThanOrEqual(1);
    // Every candidate carries BOTH a baseline and a model row — same ocid set.
    expect(modelRows.length).toBe(baseRows.length);
    expect(new Set(modelRows.map((p) => p.ocid))).toEqual(new Set(baseRows.map((p) => p.ocid)));
    // The model's number flows through verbatim (the mock's 0.42, distinct from priors).
    for (const p of modelRows) expect(p.predictedProbability).toBe(0.42);

    // The conversion witness has a baseline AND a model row that coexist (neither
    // overwrites the other) — distinguished only by predictorVersion + probability.
    const onDisk = readNdjson(predictionsPath(root)).filter((r) => r['ocid'] === CONVERSION_OCID);
    const versions = onDisk.map((r) => r['predictorVersion']).sort();
    expect(versions).toEqual([MODEL_PREDICTOR_VERSION, PREDICTOR_VERSION].sort());
    const modelDisk = notNull(
      onDisk.find((r) => r['predictorVersion'] === MODEL_PREDICTOR_VERSION) ?? null,
      'expected a model row for the conversion witness on disk',
    );
    const baseDisk = notNull(
      onDisk.find((r) => r['predictorVersion'] === PREDICTOR_VERSION) ?? null,
      'expected a baseline row for the conversion witness on disk',
    );
    expect(modelDisk['predictedProbability']).toBe(0.42);
    expect(baseDisk['predictedProbability']).toBe(0.165); // the UK3 prior — the two never collide
  });

  it('the UNMODIFIED slice-5 grader resolves ≥1 model prediction as converted (brief req 6)', async () => {
    // Full-rebuild the blended ledger, then grade it with the frozen file wrapper.
    await projectModelPredictions(root, { asof: ASOF }, makeMockModelClient());
    gradePredictions(root, { asof: ASOF });

    const predictions = readNdjson(predictionsPath(root));
    const verdicts = readNdjson(join(root, 'verdicts.ndjson'));
    expect(verdicts.length).toBe(predictions.length); // one verdict per prediction row (both predictors)

    const witnessVerdicts = verdicts.filter((v) => v['ocid'] === CONVERSION_OCID);
    expect(witnessVerdicts.length).toBe(2); // the baseline row AND the model row both resolved
    for (const v of witnessVerdicts) expect(v['verdict']).toBe('converted');
  });

  it('partitioning the returned Prediction[] yields a separable baseline-vs-model scoreboard (A1)', async () => {
    const predictions = returnedPredictions(
      await projectModelPredictions(root, { asof: ASOF }, makeMockModelClient()),
    );
    const eventsByOcid = readEventsByOcid(root);

    const modelRows = predictions.filter((p) => p.predictorVersion === MODEL_PREDICTOR_VERSION);
    const baseRows = predictions.filter((p) => p.predictorVersion === PREDICTOR_VERSION);

    // The shape the CLI serialises to scoreboard-by-predictor.json: one Scoreboard
    // per predictorVersion, graded independently with the pure grader + calibrator.
    const byPredictor: Record<string, Scoreboard> = {
      [MODEL_PREDICTOR_VERSION]: calibrate(gradePartition(modelRows, eventsByOcid, ASOF)),
      [PREDICTOR_VERSION]: calibrate(gradePartition(baseRows, eventsByOcid, ASOF)),
    };

    // Both predictor keys present, each with its own per-segment counts (A1).
    expect(Object.keys(byPredictor).sort()).toEqual([MODEL_PREDICTOR_VERSION, PREDICTOR_VERSION].sort());
    const modelSb = notNull(byPredictor[MODEL_PREDICTOR_VERSION] ?? null, 'model scoreboard missing');
    const baseSb = notNull(byPredictor[PREDICTOR_VERSION] ?? null, 'baseline scoreboard missing');

    // ≥1 model prediction graded converted (the conversion witness) — head-to-head is real.
    expect(modelSb.segments.UK3.converted).toBeGreaterThanOrEqual(1);
    expect(baseSb.segments.UK3.converted).toBeGreaterThanOrEqual(1);
    // Graded on IDENTICAL footing (same events, asof) — the verdict distribution matches;
    // only the probabilities differ, so the calibration (Brier) is SEPARABLE, not collided.
    expect(modelSb.segments.UK3.resolved).toBe(baseSb.segments.UK3.resolved);
    expect(modelSb.segments.UK3.converted).toBe(baseSb.segments.UK3.converted);
    expect(modelSb.segments.UK3.brier).not.toBe(baseSb.segments.UK3.brier);

    // The conversion witness's MODEL row specifically grades converted.
    const modelWitness = notNull(
      modelRows.find((p) => p.ocid === CONVERSION_OCID) ?? null,
      'expected a model prediction for the conversion witness',
    );
    const witnessVerdict = grade(
      {
        ocid: modelWitness.ocid,
        noticeType: modelWitness.noticeType,
        predictedProbability: modelWitness.predictedProbability,
        expectedResolutionDate: modelWitness.expectedResolutionDate,
        madeAt: modelWitness.madeAt,
      },
      eventsByOcid.get(CONVERSION_OCID) ?? [],
      { asof: ASOF },
    );
    expect(witnessVerdict.verdict).toBe('converted');
  });
});

// ── ZERO RUNTIME DEPENDENCY (brief req 8; A4) ───────────────────────────────

describe('zero runtime dependency preserved (brief req 8; A4)', () => {
  it('package.json declares no runtime dependencies and references no @anthropic-ai package', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const text = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(text) as Record<string, unknown>;
    // A4: no `dependencies` key at all, OR an empty one — never a non-empty set.
    const deps = pkg['dependencies'];
    if (deps !== undefined) {
      expect(Object.keys(deps as Record<string, unknown>)).toHaveLength(0);
    }
    expect(text).not.toContain('@anthropic-ai');
  });
});
