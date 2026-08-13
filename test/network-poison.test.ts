import { describe, expect, it } from 'vitest';

/**
 * Backstop for BUILD_BRIEF §9 / brief req 7: contract tests run with zero
 * network. test/setup.ts replaces globalThis.fetch with a throwing function;
 * this test proves the poison is installed (and therefore that
 * vitest.config.ts actually registers the setup file).
 */
describe('zero-network backstop', () => {
  it('poisons globalThis.fetch so any network call fails loudly', () => {
    // Deliberately an unroutable `.invalid` host (RFC 2606), never the real
    // FTS endpoint: the poison throws synchronously here, and if `setupFiles`
    // were ever dropped the real async `fetch` would not throw synchronously —
    // so this still fails without dialling the rate-limited production API
    // (I-m5). The `.invalid` DNS is never even reached.
    expect(() => globalThis.fetch('https://poison.invalid/never-dialled')).toThrow(
      /must not touch the network/,
    );
  });
});
