/**
 * Minimal identity validation (brief req 6): a release is ingestable when it
 * carries a non-empty `id` and a non-empty `ocid`. Field-specific checks only —
 * no substring-"test" rules, no semantic rules (invariant #19: junk is
 * semantic, not structural, and substring rules false-positive ~70× on fire
 * testing / MOT testing). Duplicate detection lives in the ingest core, which
 * has the store state this module deliberately does not.
 */

export interface ReleaseIdentity {
  id: string;
  ocid: string;
  date?: string;
}

/** Accept = null; reject = the quarantine reason. */
export function validateRelease(release: unknown): null | { reason: string } {
  if (typeof release !== 'object' || release === null) {
    return { reason: 'not-an-object' };
  }
  const candidate = release as { id?: unknown; ocid?: unknown };
  if (typeof candidate.id !== 'string' || candidate.id === '') {
    return { reason: 'missing-or-empty-id' };
  }
  if (typeof candidate.ocid !== 'string' || candidate.ocid === '') {
    return { reason: 'missing-or-empty-ocid' };
  }
  return null;
}
