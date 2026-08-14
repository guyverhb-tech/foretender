/**
 * The model predictor + fail-loud output parse (slice 7). The FIRST agent: it
 * reuses the deterministic baseline
 * `predict` VERBATIM to pick candidates and derive the no-leakage DATE cutoff,
 * then swaps only the probability — so model and baseline are graded on identical
 * footing (same `madeAt`/`expectedResolutionDate`/`noticeType`/`confidence`), and
 * the head-to-head is fair by construction (§5.1: the grader stays untouched).
 *
 * No leakage is INHERITED, not re-derived: `predict` returns `base.madeAt` = the
 * cutoff epoch; the as-of event set is rebuilt with the SAME guarded filter
 * (`toEpochMs(date) !== null && ms <= cutoff`), and identity is resolved
 * ONLY from releases whose id is in that as-of set, so nothing after the cutoff
 * can reach the prompt.
 */
import { toEpochMs } from '../lifecycle/date.js';
import { extractIdentity } from '../identity/extract.js';
import { predict } from '../prediction/predict.js';
import { DEFAULT_HORIZON_DAYS } from '../prediction/model.js';
import type { PredictOpts, Prediction } from '../prediction/model.js';
import type { LifecycleEvent } from '../lifecycle/model.js';
import { renderPrompt } from './prompt.js';
import type { ModelClient, ModelResponse } from './client.js';

/** Stamps the model prediction; keys it apart from the baseline in the shared ledger. */
export const MODEL_PREDICTOR_VERSION = 'model:claude-sonnet-5@v1';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A raw release's `id`, or null when it is absent / not a string. */
const releaseIdOf = (r: unknown): string | null =>
  isObject(r) && typeof r['id'] === 'string' ? r['id'] : null;

/**
 * Parse the model's structured output, failing LOUD on any malformation rather
 * than emitting a silent wrong-but-valid probability (brief req 3). Rejects a
 * truncated/refused stop_reason, a non-text or missing text block, non-JSON text,
 * and a probability that is missing / non-number / non-finite / out of `[0,1]`.
 */
export function parseModelOutput(response: ModelResponse): {
  probability: number;
  rationale: string;
} {
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') {
    throw new Error(
      `parseModelOutput: model stopped with «${response.stop_reason}» — output is not trustworthy`,
    );
  }
  const block = response.content.find((b) => b.type === 'text');
  if (block === undefined) throw new Error('parseModelOutput: response carries no text block');
  const text = block.text;
  if (typeof text !== 'string') throw new Error('parseModelOutput: text block carries no text field');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`parseModelOutput: model output is not valid JSON: «${text}»`);
  }
  if (!isObject(parsed)) {
    throw new Error(`parseModelOutput: model output is not a JSON object: «${text}»`);
  }
  const probability = parsed['probability'];
  if (typeof probability !== 'number' || !Number.isFinite(probability)) {
    throw new Error(
      `parseModelOutput: «probability» must be a finite number, got ${JSON.stringify(probability)}`,
    );
  }
  if (probability < 0 || probability > 1) {
    throw new Error(`parseModelOutput: «probability» must be within [0,1], got ${probability}`);
  }
  const rationale = parsed['rationale'];
  if (typeof rationale !== 'string') {
    throw new Error(`parseModelOutput: «rationale» must be a string, got ${JSON.stringify(rationale)}`);
  }
  return { probability, rationale };
}

/**
 * A model prediction for one procurement, or null when the baseline declines
 * (not pipeline as of its cutoff, or not yet makeable). The candidate set, the
 * cutoff, and every graded key field come from the baseline `predict`; only the
 * probability (from the model) and `predictorVersion` differ.
 */
export async function predictWithModel(
  events: LifecycleEvent[],
  releases: readonly unknown[],
  opts: PredictOpts,
  client: ModelClient,
): Promise<Prediction | null> {
  const base = predict(events, opts);
  if (base === null) return null;
  const cutoff = toEpochMs(base.madeAt);
  if (cutoff === null) return null; // base.madeAt is a derived ISO; defensively guarded

  // A null-dated release must NOT enter the as-of set — `null <= cutoff`
  // coerces to true, a latent leak. Mirror `predict.ts`'s `!== null` guard.
  // Order is irrelevant here (this feeds a Set of ids and the prompt renderer,
  // which sorts internally), so no sort — `renderPrompt` owns the determinism.
  const asOfEvents = events.filter((e) => {
    const ms = toEpochMs(e.date);
    return ms !== null && ms <= cutoff;
  });
  const asOfIds = new Set(asOfEvents.map((e) => e.releaseId));
  const identity = extractIdentity(
    base.ocid,
    releases.filter((r) => {
      const id = releaseIdOf(r);
      return id !== null && asOfIds.has(id);
    }),
  );

  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const req = renderPrompt(asOfEvents, identity, {
    ocid: base.ocid,
    cutoffIso: base.madeAt,
    erdIso: base.expectedResolutionDate,
    horizonDays,
  });
  const { response } = await client(req);
  const { probability } = parseModelOutput(response);

  // Spread preserves the baseline's canonical key order; only the two model
  // fields are reassigned in place — so a model row and a baseline row are
  // byte-comparable in `predictions.ndjson`.
  return { ...base, predictedProbability: probability, predictorVersion: MODEL_PREDICTOR_VERSION };
}
