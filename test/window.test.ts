import { describe, expect, it } from 'vitest';
import { londonDayRange, londonDayWindow } from '../src/ingest/window.js';

/**
 * London-day window computation (brief req 2, invariant #2, plan step 2).
 *
 * Datetimes are 19-char Europe/London LOCAL (`YYYY-MM-DDTHH:MM:SS`, seconds
 * mandatory, no `Z`). Default day = yesterday in London. The timezone trap is
 * the corpus's sharpest edge, so the "yesterday" tests pick instants where
 * the London date and the UTC date disagree — a UTC-based implementation
 * fails them.
 *
 * Interface assumption (plan leaves the export unpinned):
 *   londonDayWindow(opts?: { day?: string; now?: () => number })
 *     → { day: string; updatedFrom: string; updatedTo: string }
 * See .harness/test-plan.md §Interface assumptions.
 */
const NINETEEN_CHAR_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('londonDayWindow', () => {
  it('defaults to yesterday in London, not yesterday in UTC (just after London midnight)', () => {
    // 2026-08-11T23:30:00Z is already 2026-08-12T00:30 in London (BST +01:00):
    // London "yesterday" is 08-11; a UTC-based implementation says 08-10.
    const now = () => Date.UTC(2026, 7, 11, 23, 30, 0);
    expect(londonDayWindow({ now })).toEqual({
      day: '2026-08-11',
      updatedFrom: '2026-08-11T00:00:00',
      updatedTo: '2026-08-12T00:00:00',
    });
  });

  it('defaults to yesterday in London when London is already on the next UTC date', () => {
    // 2026-08-12T23:30:00Z is 2026-08-13T00:30 in London: London "yesterday"
    // is 08-12; a UTC-based implementation says 08-11.
    const now = () => Date.UTC(2026, 7, 12, 23, 30, 0);
    expect(londonDayWindow({ now })).toEqual({
      day: '2026-08-12',
      updatedFrom: '2026-08-12T00:00:00',
      updatedTo: '2026-08-13T00:00:00',
    });
  });

  it('formats both bounds as exactly 19 characters, seconds mandatory, no Z', () => {
    const { updatedFrom, updatedTo } = londonDayWindow({ day: '2026-08-11' });
    for (const bound of [updatedFrom, updatedTo]) {
      expect(bound).toHaveLength(19);
      expect(bound).toMatch(NINETEEN_CHAR_LOCAL);
      expect(bound).not.toContain('Z');
    }
  });

  it('honours an explicit day, producing the live-run window for 2026-08-11', () => {
    expect(londonDayWindow({ day: '2026-08-11' })).toEqual({
      day: '2026-08-11',
      updatedFrom: '2026-08-11T00:00:00',
      updatedTo: '2026-08-12T00:00:00',
    });
  });

  it('yields wall-clock midnight-to-midnight on the spring-forward day (2026-03-29)', () => {
    // Clocks go forward in London on 2026-03-29 (a 23-hour day). The window
    // is still local midnight to local midnight — no 01:00/23:00 drift.
    expect(londonDayWindow({ day: '2026-03-29' })).toEqual({
      day: '2026-03-29',
      updatedFrom: '2026-03-29T00:00:00',
      updatedTo: '2026-03-30T00:00:00',
    });
  });

  it('yields wall-clock midnight-to-midnight on the fall-back day (2026-10-25)', () => {
    // Clocks go back in London on 2026-10-25 (a 25-hour day).
    expect(londonDayWindow({ day: '2026-10-25' })).toEqual({
      day: '2026-10-25',
      updatedFrom: '2026-10-25T00:00:00',
      updatedTo: '2026-10-26T00:00:00',
    });
  });
});

/**
 * London-day RANGE iteration (brief req 6, plan step 2) — the ordered day list
 * backfill visits. The range is INCLUSIVE of both endpoints and oldest-first
 * (deterministic, so interrupt/resume is well-defined). Each element is a full
 * DayWindow produced through the same per-day path as londonDayWindow, so a
 * non-calendar bound is rejected the same way.
 *
 * Interface assumption (plan leaves the export unpinned):
 *   londonDayRange(from: string, to: string): Array<{
 *     day: string; updatedFrom: string; updatedTo: string }>
 *   — inclusive, oldest-first; throws a plain Error on a malformed bound or
 *   from > to. See .harness/test-plan.md §Interface assumptions.
 */
describe('londonDayRange', () => {
  it('returns the inclusive range oldest-first, one full window per calendar day', () => {
    expect(londonDayRange('2026-08-10', '2026-08-12')).toEqual([
      { day: '2026-08-10', updatedFrom: '2026-08-10T00:00:00', updatedTo: '2026-08-11T00:00:00' },
      { day: '2026-08-11', updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' },
      { day: '2026-08-12', updatedFrom: '2026-08-12T00:00:00', updatedTo: '2026-08-13T00:00:00' },
    ]);
  });

  it('is inclusive of both endpoints — a single-day range yields exactly that day', () => {
    expect(londonDayRange('2026-08-11', '2026-08-11')).toEqual([
      { day: '2026-08-11', updatedFrom: '2026-08-11T00:00:00', updatedTo: '2026-08-12T00:00:00' },
    ]);
  });

  it('orders days ascending, each window abutting the next with no gap or overlap', () => {
    const range = londonDayRange('2026-08-10', '2026-08-12');
    expect(range.map((w) => w.day)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    for (let i = 1; i < range.length; i++) {
      expect(range[i]?.updatedFrom).toBe(range[i - 1]?.updatedTo);
    }
  });

  it('rolls the calendar over across a month boundary', () => {
    // October has 31 days: 10-30, 10-31, then 11-01, 11-02.
    expect(londonDayRange('2026-10-30', '2026-11-02').map((w) => w.day)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('spans the autumn DST fall-back day with plain calendar days, no clock drift', () => {
    // Clocks go back in London on 2026-10-25; the range is still whole calendar
    // days, each local-midnight to local-midnight (no 01:00/23:00 drift).
    expect(londonDayRange('2026-10-24', '2026-10-26')).toEqual([
      { day: '2026-10-24', updatedFrom: '2026-10-24T00:00:00', updatedTo: '2026-10-25T00:00:00' },
      { day: '2026-10-25', updatedFrom: '2026-10-25T00:00:00', updatedTo: '2026-10-26T00:00:00' },
      { day: '2026-10-26', updatedFrom: '2026-10-26T00:00:00', updatedTo: '2026-10-27T00:00:00' },
    ]);
  });

  it('rejects an inverted range (from later than to)', () => {
    expect(() => londonDayRange('2026-08-12', '2026-08-10')).toThrow();
  });

  it('rejects a non-calendar or malformed bound', () => {
    expect(() => londonDayRange('2026-02-30', '2026-03-02')).toThrow();
    expect(() => londonDayRange('2026-08-10', 'not-a-date')).toThrow();
  });
});
