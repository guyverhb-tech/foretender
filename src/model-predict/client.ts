/**
 * The Anthropic Messages wire contract as an injected seam (slice 7). Type-only
 * + pure helpers — no I/O, no `fetch`, no key: the LIVE
 * transport lives alone in `src/cli/live-model.ts`, the record/replay wrapper in
 * `ledger.ts`, and the tests inject a mock. Every consumer binds to THIS
 * contract, so the model is a one-line swap (`MODEL_ID`) and the request bytes
 * are produced by a SINGLE `serializeRequest` shared by the live shell and the
 * ledger — the bytes the ledger hashes are exactly the body the shell sends.
 *
 * Verified against `.harness/research/anthropic-api.md` (anthropic-version
 * 2023-06-01): body `{model, max_tokens (required), messages, system?,
 * temperature?}`; text at the first `content[]` block with `type:"text"`;
 * `usage.input_tokens`/`output_tokens`; `stop_reason` guarded downstream. The
 * endpoint URL + version header are the live shell's alone (it is the only file
 * that touches the network), so they are not named here.
 */

/** One message in a Messages request; `content` is the plain-string form (research §3). */
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A non-streaming Messages request in CANONICAL key order — the serialised bytes are load-bearing. */
export interface ModelRequest {
  model: string;
  max_tokens: number;
  messages: ModelMessage[];
  system?: string;
  temperature?: number;
}

/** Token accounting echoed on every response (research §4). */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

/** One response content block; only a `type:"text"` block carries `text`. */
export interface ModelContentBlock {
  type: string;
  text?: string;
}

/** The Messages response envelope (research §4). */
export interface ModelResponse {
  id: string;
  model: string;
  content: ModelContentBlock[];
  stop_reason: string | null;
  usage: ModelUsage;
}

/** A completed call: the parsed envelope plus the verbatim response bytes the ledger records. */
export interface ModelResult {
  response: ModelResponse;
  raw: Uint8Array;
}

/** The injected seam: mock (tests), record/replay (`ledger.ts`), or live (`live-model.ts`). */
export type ModelClient = (req: ModelRequest) => Promise<ModelResult>;

/** The Sonnet-5 Claude API id (research §5) — the one-line model swap point. */
export const MODEL_ID = 'claude-sonnet-5';
/** A small output budget: this call emits a two-field JSON object (research §3 — 512 is valid). */
export const MAX_TOKENS = 512;
/** Analytical task → temperature 0 (NOT for reproducibility — replay comes from the ledger). */
export const TEMPERATURE = 0;

/**
 * The canonical request bytes: `JSON.stringify` of the request in its declared
 * key order. Used by BOTH the live shell (the body it POSTs) and the ledger (the
 * bytes it hashes), so `requestHash` is exactly the sent body. No secret is
 * present — the `x-api-key` header lives only in the live shell.
 */
export function serializeRequest(req: ModelRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate raw response bytes into a `ModelResponse`, failing LOUD on any drift
 * from the wire contract (research §4). Used by the live shell (on a 200) and by
 * the ledger's HIT path (re-reading recorded bytes) — a tampered or foreign body
 * throws here rather than feeding a coerced envelope downstream.
 */
export function parseModelResponse(raw: Uint8Array): ModelResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    throw new Error(
      `parseModelResponse: response body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error('parseModelResponse: response body is not a JSON object');
  }
  const { id, model, content, stop_reason: stopReason, usage } = parsed;
  if (typeof id !== 'string') throw new Error('parseModelResponse: «id» must be a string');
  if (typeof model !== 'string') throw new Error('parseModelResponse: «model» must be a string');
  if (!Array.isArray(content)) throw new Error('parseModelResponse: «content» must be an array');
  const blocks: ModelContentBlock[] = content.map((block, i) => {
    if (!isObject(block) || typeof block['type'] !== 'string') {
      throw new Error(`parseModelResponse: content[${i}].type must be a string`);
    }
    const text = block['text'];
    if (text !== undefined && typeof text !== 'string') {
      throw new Error(`parseModelResponse: content[${i}].text must be a string when present`);
    }
    return text === undefined ? { type: block['type'] } : { type: block['type'], text };
  });
  if (stopReason !== null && typeof stopReason !== 'string') {
    throw new Error('parseModelResponse: «stop_reason» must be a string or null');
  }
  if (
    !isObject(usage) ||
    typeof usage['input_tokens'] !== 'number' ||
    typeof usage['output_tokens'] !== 'number'
  ) {
    throw new Error('parseModelResponse: «usage» must carry numeric input_tokens/output_tokens');
  }
  return {
    id,
    model,
    content: blocks,
    stop_reason: stopReason,
    usage: { input_tokens: usage['input_tokens'], output_tokens: usage['output_tokens'] },
  };
}
