/**
 * The times "Remind me…" offers, worked out in the viewer's own time zone: the wall clock a person
 * reads, never UTC's. The zone is an argument so a test names one (`i18n/format.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { createFormatters } from '../../../i18n/format';
import { reminderBounds, reminderPresets, validateReminder } from './presets';

const istanbul = createFormatters('en', 'Europe/Istanbul');
const berlin = createFormatters('en', 'Europe/Berlin');
const utc = createFormatters('en', 'UTC');

/** The presets as `[id, wall clock]` pairs, read back in the same zone. */
const wallOf = (
  format: ReturnType<typeof createFormatters>,
  now: string,
): readonly (readonly [string, string])[] =>
  reminderPresets(new Date(now), format).map(({ id, at }) => [id, format.inputValue(at)]);

describe('the wall clock and the instant', () => {
  test('an instant is read in the zone, and an input read back is the same instant', () => {
    expect(istanbul.inputValue('2026-11-18T10:30:00Z')).toBe('2026-11-18T13:30');
    expect(istanbul.instantOf('2026-11-18T13:30')).toBe('2026-11-18T10:30:00.000Z');
  });

  test('a time a clock change repeats is the first of the two', () => {
    // Berlin, 2026-10-25: 02:30 happens twice (00:30Z, then 01:30Z).
    expect(berlin.instantOf('2026-10-25T02:30')).toBe('2026-10-25T00:30:00.000Z');
  });

  test('a time a clock change skips is the moment after the gap', () => {
    // Berlin, 2026-03-29: 02:30 never happens; the clock goes from 02:00 to 03:00.
    expect(berlin.instantOf('2026-03-29T02:30')).toBe('2026-03-29T01:30:00.000Z');
    expect(berlin.inputValue('2026-03-29T01:30:00Z')).toBe('2026-03-29T03:30');
  });

  test.each(['', '2026-11-18', '2026-13-01T10:00', '2026-02-30T10:00', '2026-11-18T25:00', 'soon'])(
    'cannot be read from %p',
    (typed) => {
      expect(utc.instantOf(typed)).toBeNull();
    },
  );
});

describe('the presets', () => {
  test('in the viewer’s zone: Istanbul is three hours ahead of UTC', () => {
    expect(wallOf(istanbul, '2026-11-18T10:00:00Z')).toEqual([
      ['in20m', '2026-11-18T13:20'],
      ['in1h', '2026-11-18T14:00'],
      ['in3h', '2026-11-18T16:00'],
      ['tomorrow', '2026-11-19T09:00'],
      ['monday', '2026-11-23T09:00'],
    ]);
  });

  test('tomorrow is the viewer’s tomorrow, not UTC’s: 23:30 in Istanbul is still the 18th', () => {
    expect(wallOf(istanbul, '2026-11-18T20:30:00Z').at(3)).toEqual([
      'tomorrow',
      '2026-11-19T09:00',
    ]);
    // 01:00 in Istanbul on the 19th is the 18th in UTC.
    expect(wallOf(istanbul, '2026-11-18T22:00:00Z').at(3)).toEqual([
      'tomorrow',
      '2026-11-20T09:00',
    ]);
  });

  test.each([
    // 2026-11-16 is a Monday.
    ['Monday morning', '2026-11-16T06:00:00Z', '2026-11-23T09:00'],
    ['Tuesday', '2026-11-17T06:00:00Z', '2026-11-23T09:00'],
    ['Sunday', '2026-11-22T06:00:00Z', '2026-11-23T09:00'],
    ['Saturday night', '2026-11-21T22:00:00Z', '2026-11-23T09:00'],
  ])('next Monday from %s is the Monday after it, never today', (_day, now, expected) => {
    expect(wallOf(utc, now).at(4)).toEqual(['monday', expected]);
  });

  test('rolls over a month and a year', () => {
    expect(wallOf(utc, '2026-12-31T18:00:00Z').slice(3)).toEqual([
      ['tomorrow', '2027-01-01T09:00'],
      ['monday', '2027-01-04T09:00'],
    ]);
    expect(wallOf(utc, '2028-02-28T18:00:00Z').at(3)).toEqual(['tomorrow', '2028-02-29T09:00']);
  });

  test('across a clock change, 09:00 is still 09:00 on the wall', () => {
    // Berlin falls back on 2026-10-25; asked on the 24th, tomorrow's 09:00 is 25 hours away.
    const [, , , tomorrow] = reminderPresets(new Date('2026-10-24T10:00:00Z'), berlin);
    expect(tomorrow?.at).toBe('2026-10-25T08:00:00.000Z');
    expect(berlin.inputValue(tomorrow?.at ?? '')).toBe('2026-10-25T09:00');
    // And forward on 2026-03-29: 09:00 that day is 23 hours after 09:00 the day before.
    const [, , , spring] = reminderPresets(new Date('2026-03-28T08:00:00Z'), berlin);
    expect(spring?.at).toBe('2026-03-29T07:00:00.000Z');
  });

  test('the relative ones are exact offsets from now', () => {
    const now = new Date('2026-11-18T10:00:00Z');
    expect(
      reminderPresets(now, utc)
        .slice(0, 3)
        .map(({ at }) => at),
    ).toEqual(['2026-11-18T10:20:00.000Z', '2026-11-18T11:00:00.000Z', '2026-11-18T13:00:00.000Z']);
  });
});

describe('the date and time a person types', () => {
  const now = new Date('2026-11-18T10:00:30Z');

  test('the bounds are a minute ahead (rounded up to a whole minute) and a year at most', () => {
    expect(reminderBounds(now, utc)).toEqual({ min: '2026-11-18T10:02', max: '2027-11-18T09:59' });
  });

  test('a time in range is the instant it names, in the viewer’s zone', () => {
    expect(validateReminder('2026-11-18T14:00', now, istanbul)).toEqual({
      ok: true,
      at: '2026-11-18T11:00:00.000Z',
    });
  });

  test.each([
    ['', 'missing'],
    ['2026-11-18', 'missing'],
    ['2026-11-18T10:00', 'past'],
    ['2026-11-18T10:01', 'past'],
    ['2028-01-01T10:00', 'far'],
  ] as const)('%p is refused as %s', (typed, reason) => {
    expect(validateReminder(typed, now, utc)).toEqual({ ok: false, reason });
  });

  test('the first minute that is far enough ahead is accepted', () => {
    expect(validateReminder('2026-11-18T10:02', now, utc).ok).toBe(true);
  });
});
