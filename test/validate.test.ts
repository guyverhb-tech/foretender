import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateRelease } from '../src/ingest/validate.js';
import { fixturePath, type PackagePage } from './helpers/fixture-transport.js';

/**
 * Minimal identity validation (brief req 6, invariant #19, plan step 4).
 *
 * Field-specific only: missing/empty `id`, missing/empty `ocid`. No
 * substring-"test" rules, no semantic rules — those false-positive ~70×
 * (fire testing, MOT testing) and belong to no layer in this slice.
 *
 * The rejection cases use synthetic records, explicitly labelled: the corpus
 * contains zero malformed records (package-shape.md:168), so reality has not
 * yet produced these inputs. This is the plan's documented deviation from
 * BUILD_BRIEF §9's real-fixture rule.
 *
 * Interface assumption (plan says "returning accept or {reason}"):
 *   validateRelease(release: unknown): null | { reason: string }
 * Accept = null. See .harness/test-plan.md §Interface assumptions.
 */
describe('validateRelease', () => {
  it('accepts every release on the real first page (100/100)', () => {
    const page = JSON.parse(
      readFileSync(fixturePath('whole-stream/page-001.json'), 'utf8'),
    ) as PackagePage;
    expect(page.releases).toHaveLength(100);
    for (const release of page.releases) {
      expect(validateRelease(release) ?? null).toBeNull();
    }
  });

  it('rejects a release missing id, with a recorded reason', () => {
    // SYNTHETIC record — no malformed record exists in the corpus.
    const result = validateRelease({ ocid: 'ocds-h6vhtk-synthetic-1' });
    expect(result).not.toBeNull();
    expect(result?.reason).toMatch(/\S/);
  });

  it('rejects a release with an empty id, with a recorded reason', () => {
    // SYNTHETIC record.
    const result = validateRelease({ id: '', ocid: 'ocds-h6vhtk-synthetic-2' });
    expect(result).not.toBeNull();
    expect(result?.reason).toMatch(/\S/);
  });

  it('rejects a release missing ocid, with a recorded reason', () => {
    // SYNTHETIC record.
    const result = validateRelease({ id: '999999-2026' });
    expect(result).not.toBeNull();
    expect(result?.reason).toMatch(/\S/);
  });

  it('rejects a release with an empty ocid, with a recorded reason', () => {
    // SYNTHETIC record.
    const result = validateRelease({ id: '999998-2026', ocid: '' });
    expect(result).not.toBeNull();
    expect(result?.reason).toMatch(/\S/);
  });

  it('does not reject on the substring "test" (invariant #19)', () => {
    // SYNTHETIC record shaped like the real false-positive classes
    // (fire testing, MOT testing): identity is present, so it must pass.
    const result = validateRelease({
      id: '999997-2026',
      ocid: 'ocds-h6vhtk-synthetic-3',
      tender: { title: 'Fire testing and MOT testing services' },
    });
    expect(result ?? null).toBeNull();
  });
});
