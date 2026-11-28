import { describe, expect, test } from 'bun:test';
import { dayStamp, rowStamp } from './now-minute';

const at = (iso: string): number => Date.parse(iso);

describe('what a row is drawn as of', () => {
  test('a message under an hour old follows the minute, so its age stays right', () => {
    const now = at('2026-11-28T12:30:00Z');
    expect(rowStamp('2026-11-28T12:10:00Z', now)).toBe(now);
    expect(rowStamp('2026-11-28T12:10:00Z', now + 60_000)).toBe(now + 60_000);
  });

  test('an older one holds still between quarters, so it is not drawn again each minute', () => {
    const created = '2026-11-28T08:00:00Z';
    const first = rowStamp(created, at('2026-11-28T12:31:00Z'));
    expect(rowStamp(created, at('2026-11-28T12:32:00Z'))).toBe(first);
    expect(rowStamp(created, at('2026-11-28T12:44:00Z'))).toBe(first);
    expect(rowStamp(created, at('2026-11-28T12:46:00Z'))).not.toBe(first);
  });

  test('the day labels hold for a quarter hour, which no zone’s midnight falls inside', () => {
    expect(dayStamp(at('2026-11-28T12:31:00Z'))).toBe(dayStamp(at('2026-11-28T12:44:00Z')));
    expect(dayStamp(at('2026-11-28T12:46:00Z'))).not.toBe(dayStamp(at('2026-11-28T12:44:00Z')));
  });
});
