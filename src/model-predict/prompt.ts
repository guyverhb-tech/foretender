/**
 * The versioned prompt renderer (slice 7). Pure: no clock,
 * no I/O — `renderPrompt` is a deterministic function of (as-of context,
 * `PROMPT_VERSION`), so identical inputs yield a byte-identical `ModelRequest`
 * and therefore a stable `requestHash` that the ledger replays idempotently.
 *
 * The prompt describes ONLY the as-of context: the resolved identity and the
 * events dated at or before the cutoff (the caller passes an already-cutoff set;
 * no post-cutoff release can reach here — the no-leakage crux is inherited from
 * `predictWithModel`). The strict-JSON output contract is stated in the system
 * message; `parseModelOutput` (predict.ts) enforces it fail-loud regardless.
 */
import { sortEvents } from '../lifecycle/machine.js';
import type { LifecycleEvent } from '../lifecycle/model.js';
import type { Identity } from '../identity/model.js';
import { MAX_TOKENS, MODEL_ID, TEMPERATURE } from './client.js';
import type { ModelRequest } from './client.js';

/** Bumped whenever the prompt text changes; stamped into every ledger record. */
export const PROMPT_VERSION = 'pipeline-to-tender-model@v1';

const SYSTEM = [
  'You are a UK public-procurement analyst.',
  'A procurement is currently at the PLANNING stage: a prior-information / pipeline notice has',
  'been published, but no tender notice yet.',
  'Estimate the probability that a TENDER notice for this procurement will be published on or',
  'before the given expected-resolution date.',
  'You are shown ONLY the information available as of the cutoff; do not assume any later event.',
  'Reply with a SINGLE strict JSON object and NOTHING else:',
  '{"probability": <number in [0,1]>, "rationale": "<one short sentence>"}.',
  'No prose, no code fences, no text outside the JSON object.',
].join(' ');

export interface PromptContext {
  ocid: string;
  cutoffIso: string;
  erdIso: string;
  horizonDays: number;
}

/** One line per as-of event: release id, date, tags, noticeType, regime. */
function eventLine(ev: LifecycleEvent): string {
  return (
    `- ${ev.releaseId} | date ${ev.date ?? 'unknown'} | tags ${ev.tag.join(',')} | ` +
    `noticeType ${ev.noticeType ?? 'none'} | regime ${ev.regime ?? 'none'}`
  );
}

export function renderPrompt(
  asOfEvents: LifecycleEvent[],
  identity: Identity,
  ctx: PromptContext,
): ModelRequest {
  const lines: string[] = [`ocid: ${ctx.ocid}`];
  if (identity.title !== null) lines.push(`title: ${identity.title}`);
  if (identity.buyer !== null) lines.push(`buyer: ${identity.buyer}`);
  const currency = identity.value.currency !== null ? ` ${identity.value.currency}` : '';
  if (identity.value.gross !== null) lines.push(`value (gross): ${identity.value.gross}${currency}`);
  else if (identity.value.net !== null) lines.push(`value (net): ${identity.value.net}${currency}`);
  lines.push(`as-of cutoff: ${ctx.cutoffIso}`);
  lines.push(`expected resolution date: ${ctx.erdIso} (horizon ${ctx.horizonDays} days)`);
  lines.push('as-of notices (oldest first):');
  for (const ev of sortEvents(asOfEvents)) lines.push(eventLine(ev));

  // Canonical key order — the serialised bytes are the ledger's idempotency key.
  return {
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: lines.join('\n') }],
    system: SYSTEM,
    temperature: TEMPERATURE,
  };
}
