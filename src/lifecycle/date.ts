/**
 * The offset-aware epoch primitive and `--asof` validator (plan slice-5 step 2).
 * Pure: no I/O, no clock. Placed in the lifecycle layer so both the prediction
 * and grading layers — which already depend on lifecycle — share it downward
 * without duplication and without importing each other.
 *
 * The date comparison the cutoff filter and the grader both rest on is by
 * EPOCH, not by string: FTS notice dates carry an explicit offset (`+01:00`) and
 * lexicographic order breaks across a BST/GMT boundary, so only a parsed epoch
 * orders them correctly (invariant #2). `Date.parse` is TZ-correct for any
 * offset-carrying string, but a BARE 19-char datetime with no offset is read in
 * the runner's local zone — an environment-dependent epoch. That is why the one
 * input the caller supplies without a guaranteed offset (`--asof`) is refused
 * unless it carries `Z` or `±HH:MM`: §5.3 replay must not differ between a UTC
 * CI run and a Europe/London machine.
 */

/** ISO-8601 with an explicit offset (Z or ±HH:MM), seconds mandatory. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Parse an ISO date to an offset-aware epoch; null/non-string/unparsable → null. */
export function toEpochMs(iso: string | null): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Return `iso` unchanged iff it carries an explicit offset AND names a real
 * calendar instant; otherwise throw a clear error naming `label`. The bare
 * 19-char local form is REJECTED because its epoch would depend on the runner's
 * timezone, breaking deterministic replay. A value that passes the shape check
 * but is calendar-invalid (e.g. month 13 / day 45) is ALSO rejected: `Date.parse`
 * returns NaN for it, which would otherwise degrade to a null epoch and silently
 * grade everything `pending` on the `--asof`/ERD boundary.
 */
export function requireOffsetIso(iso: string, label: string): string {
  if (!ISO_WITH_OFFSET.test(iso)) {
    throw new Error(
      `${label} must carry an explicit timezone offset (Z or ±HH:MM); got «${iso}» — ` +
        `a bare local datetime is rejected because its epoch depends on the runner's timezone`,
    );
  }
  if (Number.isNaN(Date.parse(iso))) {
    throw new Error(
      `${label} is shape-valid but not a real calendar datetime; got «${iso}» — ` +
        `its epoch would be NaN (e.g. a month or day out of range)`,
    );
  }
  return iso;
}
