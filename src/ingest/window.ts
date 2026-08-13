/**
 * London-day window computation (invariant #2).
 *
 * FTS query datetimes are 19-char Europe/London LOCAL strings
 * (`YYYY-MM-DDTHH:MM:SS`, seconds mandatory, no `Z`). A day window is wall-clock
 * midnight to wall-clock midnight, so the bounds are pure calendar arithmetic —
 * DST transitions (23- and 25-hour days) change the day's length, never its
 * bounds. The timezone only enters when resolving "yesterday": the current
 * London date can differ from the UTC date in both directions.
 */

export interface DayWindow {
  /** The London calendar day being fetched, `YYYY-MM-DD`. */
  day: string;
  /** Inclusive lower bound, 19-char London-local. */
  updatedFrom: string;
  /** Exclusive upper bound (next day's midnight), 19-char London-local. */
  updatedTo: string;
}

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

const LONDON_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The London calendar date (`YYYY-MM-DD`) of an epoch-milliseconds instant. */
function londonDateOf(epochMs: number): string {
  const parts = LONDON_DATE.formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) {
      throw new Error(`Intl produced no «${type}» part for Europe/London`);
    }
    return found.value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Shift a `YYYY-MM-DD` calendar day by whole days — no timezone involved. */
function shiftCalendarDay(day: string, deltaDays: number): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  if (year === undefined || month === undefined || dayOfMonth === undefined) {
    throw new Error(`day must be YYYY-MM-DD, got «${day}»`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, dayOfMonth + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

/**
 * The fetch window for one London day. With no `day`, the day is yesterday in
 * Europe/London as of `now` (default: the real clock).
 */
export function londonDayWindow(opts?: { day?: string; now?: () => number }): DayWindow {
  const day = opts?.day ?? shiftCalendarDay(londonDateOf((opts?.now ?? Date.now)()), -1);
  if (!DAY_FORMAT.test(day)) {
    throw new Error(`day must be YYYY-MM-DD, got «${day}»`);
  }
  // Shape is not a calendar: `Date.UTC` rolls invalid dates over (2026-06-31 →
  // 2026-07-01, 2026-02-29 → 2026-03-01, 2026-00-00 → 2025-11-30), which would
  // silently return a window that is not one London day. Round-trip the parsed
  // date and reject anything that isn't a real calendar day.
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const roundTrip = new Date(Date.UTC(year, month - 1, dayOfMonth)).toISOString().slice(0, 10);
  if (roundTrip !== day) {
    throw new Error(`day must be a real calendar date YYYY-MM-DD, got «${day}»`);
  }
  return {
    day,
    updatedFrom: `${day}T00:00:00`,
    updatedTo: `${shiftCalendarDay(day, 1)}T00:00:00`,
  };
}
