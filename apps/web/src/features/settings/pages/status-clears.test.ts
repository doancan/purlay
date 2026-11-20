/**
 * When a status line clears itself (D-330): spans from now, and "today" and "this week" at the viewer's own
 * midnights — a zone's, not UTC's — inside the server's week.
 */
import { describe, expect, test } from 'bun:test';
import { STATUS_UNTIL_MAX_DAYS } from '@purlay/types';
import { createFormatters } from '../../../i18n/format';
import { STATUS_CLEARS, statusEnd } from './status-clears';

const HOUR_MS = 3_600_000;
const zone = (name: string): ReturnType<typeof createFormatters> => createFormatters('tr', name);

describe('the end of a status line', () => {
  test('don’t clear has none; a span is that long from now', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    const utc = zone('UTC');
    expect(statusEnd('never', now, utc)).toBeNull();
    expect(statusEnd('30m', now, utc)).toBe('2026-11-20T10:30:00.000Z');
    expect(statusEnd('1h', now, utc)).toBe('2026-11-20T11:00:00.000Z');
    expect(statusEnd('4h', now, utc)).toBe('2026-11-20T14:00:00.000Z');
  });

  test('today ends at the viewer’s midnight: Istanbul’s is 21:00 UTC', () => {
    // 23:30 in Istanbul on Friday the 20th: midnight there is half an hour away.
    const now = new Date('2026-11-20T20:30:00.000Z');
    expect(statusEnd('today', now, zone('Europe/Istanbul'))).toBe('2026-11-20T21:00:00.000Z');
    // The same instant is still 15:30 on the 20th in New York: its midnight is 05:00 UTC on the 21st.
    expect(statusEnd('today', now, zone('America/New_York'))).toBe('2026-11-21T05:00:00.000Z');
  });

  test('this week ends as next Monday begins, there', () => {
    // Friday the 20th in Istanbul: Monday the 23rd begins at 21:00 UTC on the 22nd.
    const friday = new Date('2026-11-20T10:00:00.000Z');
    expect(statusEnd('week', friday, zone('Europe/Istanbul'))).toBe('2026-11-22T21:00:00.000Z');
    // On a Monday, it is the Monday after.
    const monday = new Date('2026-11-23T10:00:00.000Z');
    expect(statusEnd('week', monday, zone('Europe/Istanbul'))).toBe('2026-11-29T21:00:00.000Z');
  });

  test('a week across a clock change is still inside the server’s bound', () => {
    // 00:30 on Monday 30 March 2026 in London, the day after the clocks went forward.
    const now = new Date('2026-03-29T23:30:00.000Z');
    for (const choice of STATUS_CLEARS) {
      const end = statusEnd(choice, now, zone('Europe/London'));
      if (end === null) continue;
      expect(new Date(end).getTime()).toBeGreaterThan(now.getTime());
      expect(new Date(end).getTime()).toBeLessThanOrEqual(
        now.getTime() + STATUS_UNTIL_MAX_DAYS * 24 * HOUR_MS,
      );
    }
  });
});
