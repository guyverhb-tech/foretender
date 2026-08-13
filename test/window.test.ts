import { describe, expect, it } from 'vitest';
import { londonDayWindow } from '../src/ingest/window.js';

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
