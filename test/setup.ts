/**
 * Vitest setup — zero-network backstop (plan §Approach, delegated decision 4).
 *
 * Injection is the primary guarantee: the ingest core only speaks through an
 * injected transport, and contract tests inject a fixture transport. This
 * poison is the backstop that makes any accidental network call fail loudly.
 * Node 22's global fetch is undici and does not route through node:http, so
 * poisoning globalThis.fetch is the poison that matters.
 *
 * vitest.config.ts must register this file via `test.setupFiles` — the
 * network-poison test fails if it doesn't, which is deliberate.
 */
const poisonedFetch = (input: unknown): never => {
  throw new Error(
    `contract tests must not touch the network (attempted fetch of ${String(input)})`,
  );
};

globalThis.fetch = poisonedFetch as unknown as typeof fetch;
